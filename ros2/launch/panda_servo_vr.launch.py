import os

import yaml
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.descriptions import ComposableNode
from moveit_configs_utils import MoveItConfigsBuilder


RUNTIME_ROOT = "/opt/vr_teleop/ros2"


def load_yaml(package, relative_path):
    path = os.path.join(get_package_share_directory(package), relative_path)
    with open(path, encoding="utf-8") as stream:
        return yaml.safe_load(stream)


def generate_launch_description():
    moveit_config = (
        MoveItConfigsBuilder("moveit_resources_panda")
        .robot_description(file_path="config/panda.urdf.xacro")
        .to_moveit_configs()
    )

    # FakeSystem has a fixed base and does not publish MultiDOFJointState.
    semantic_key = "robot_description_semantic"
    semantic_xml = moveit_config.robot_description_semantic[semantic_key]
    if 'name="virtual_joint"' not in semantic_xml or 'type="floating"' not in semantic_xml:
        raise RuntimeError("Expected a floating Panda virtual_joint in the SRDF")
    moveit_config.robot_description_semantic[semantic_key] = semantic_xml.replace(
        'type="floating"', 'type="fixed"', 1
    )

    servo_yaml = load_yaml("moveit_servo", "config/panda_simulated_config.yaml")
    # FakeSystem visualization only. Never disable collision checks on hardware.
    servo_yaml["check_collisions"] = False
    servo_params = {"moveit_servo": servo_yaml}

    rviz = Node(
        package="rviz2",
        executable="rviz2",
        arguments=["-d", os.path.join(RUNTIME_ROOT, "config/panda_live.rviz")],
        parameters=[
            moveit_config.robot_description,
            moveit_config.robot_description_semantic,
        ],
        output="log",
    )

    controllers_yaml = os.path.join(
        get_package_share_directory("moveit_resources_panda_moveit_config"),
        "config",
        "ros2_controllers.yaml",
    )
    ros2_control = Node(
        package="controller_manager",
        executable="ros2_control_node",
        parameters=[moveit_config.robot_description, controllers_yaml],
        output="screen",
    )

    panda_servo = Node(
        package="moveit_servo",
        executable="servo_node_main",
        name="panda_servo",
        parameters=[
            servo_params,
            moveit_config.robot_description,
            moveit_config.robot_description_semantic,
            moveit_config.robot_description_kinematics,
        ],
        output="screen",
    )

    pose_bridge = ExecuteProcess(
        cmd=["python3", os.path.join(RUNTIME_ROOT, "scripts/pose_to_twist_bridge.py")],
        output="screen",
    )

    rsp_container = ComposableNodeContainer(
        name="rsp_container",
        namespace="/",
        package="rclcpp_components",
        executable="component_container_mt",
        composable_node_descriptions=[
            ComposableNode(
                package="robot_state_publisher",
                plugin="robot_state_publisher::RobotStatePublisher",
                parameters=[moveit_config.robot_description],
            )
        ],
        output="screen",
    )

    return LaunchDescription(
        [
            rviz,
            ros2_control,
            Node(
                package="controller_manager",
                executable="spawner",
                arguments=["joint_state_broadcaster"],
            ),
            Node(
                package="controller_manager",
                executable="spawner",
                arguments=["panda_arm_controller"],
            ),
            Node(
                package="controller_manager",
                executable="spawner",
                arguments=["panda_hand_controller"],
            ),
            panda_servo,
            rsp_container,
            pose_bridge,
        ]
    )
