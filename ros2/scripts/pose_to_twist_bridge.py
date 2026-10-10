#!/usr/bin/env python3
import math

import rclpy
from control_msgs.action import GripperCommand
from geometry_msgs.msg import PoseStamped, TwistStamped
from rclpy.action import ActionClient
from rclpy.duration import Duration
from rclpy.node import Node
from std_msgs.msg import Bool
from tf2_ros import Buffer, TransformException, TransformListener


def clamp_norm(values, limit):
    norm = math.sqrt(sum(value * value for value in values))
    if norm <= limit or norm == 0.0:
        return values
    scale = limit / norm
    return [value * scale for value in values]


def quaternion_error(target, current):
    tx, ty, tz, tw = target
    cx, cy, cz, cw = current
    x = -tw * cx + tx * cw - ty * cz + tz * cy
    y = -tw * cy + tx * cz + ty * cw - tz * cx
    z = -tw * cz - tx * cy + ty * cx + tz * cw
    w = tw * cw + tx * cx + ty * cy + tz * cz

    norm = math.sqrt(x * x + y * y + z * z + w * w)
    if norm == 0.0:
        return [0.0, 0.0, 0.0]
    x, y, z, w = x / norm, y / norm, z / norm, w / norm
    if w < 0.0:
        x, y, z, w = -x, -y, -z, -w

    vector_norm = math.sqrt(x * x + y * y + z * z)
    if vector_norm < 1e-6:
        return [0.0, 0.0, 0.0]
    angle = 2.0 * math.atan2(vector_norm, max(-1.0, min(1.0, w)))
    return [angle * x / vector_norm, angle * y / vector_norm, angle * z / vector_norm]


class PoseToTwistBridge(Node):
    def __init__(self):
        super().__init__("pose_to_twist_bridge")

        self.declare_parameter("base_frame", "panda_link0")
        self.declare_parameter("ee_frame", "panda_link8")
        self.declare_parameter("linear_gain", 2.0)
        self.declare_parameter("angular_gain", 1.0)
        self.declare_parameter("max_linear_speed", 0.25)
        self.declare_parameter("max_angular_speed", 0.5)
        self.declare_parameter("filter_alpha", 0.4)
        self.declare_parameter("control_orientation", False)
        self.declare_parameter("command_timeout", 0.25)
        self.declare_parameter("gripper_open_position", 0.035)
        self.declare_parameter("gripper_closed_position", 0.0)
        self.declare_parameter("gripper_max_effort", 20.0)

        self.base_frame = self.get_parameter("base_frame").value
        self.ee_frame = self.get_parameter("ee_frame").value
        self.linear_gain = self.get_parameter("linear_gain").value
        self.angular_gain = self.get_parameter("angular_gain").value
        self.max_linear_speed = self.get_parameter("max_linear_speed").value
        self.max_angular_speed = self.get_parameter("max_angular_speed").value
        self.filter_alpha = self.get_parameter("filter_alpha").value
        self.control_orientation = self.get_parameter("control_orientation").value
        self.command_timeout = self.get_parameter("command_timeout").value
        self.gripper_open_position = self.get_parameter("gripper_open_position").value
        self.gripper_closed_position = self.get_parameter("gripper_closed_position").value
        self.gripper_max_effort = self.get_parameter("gripper_max_effort").value

        self.target = None
        self.last_target_time = None
        self.enabled = False
        self.filtered = [0.0] * 6
        self.last_gripper_closed = None

        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self.twist_pub = self.create_publisher(
            TwistStamped, "/panda_servo/delta_twist_cmds", 10
        )
        self.create_subscription(
            PoseStamped, "/panda_servo/pose_target", self.target_callback, 10
        )
        self.create_subscription(Bool, "/vr/teleop_enabled", self.enable_callback, 10)
        self.create_subscription(Bool, "/vr/gripper_cmd", self.gripper_callback, 10)
        self.gripper_client = ActionClient(
            self, GripperCommand, "/panda_hand_controller/gripper_cmd"
        )
        self.create_timer(0.02, self.control_loop)
        self.get_logger().info(
            "Pose-to-Twist bridge ready; publish true on /vr/teleop_enabled to move."
        )

    def target_callback(self, msg):
        if msg.header.frame_id and msg.header.frame_id != self.base_frame:
            self.get_logger().warning(
                f"Ignoring target in {msg.header.frame_id}; expected {self.base_frame}."
            )
            return
        self.target = msg.pose
        self.last_target_time = self.get_clock().now()

    def enable_callback(self, msg):
        self.enabled = msg.data
        if not self.enabled:
            self.filtered = [0.0] * 6
            self.publish_twist([0.0] * 6)
        state = "enabled" if self.enabled else "disabled"
        self.get_logger().info(f"Teleoperation {state}.")

    def gripper_callback(self, msg):
        if msg.data == self.last_gripper_closed:
            return
        if not self.gripper_client.server_is_ready():
            self.get_logger().warning("Gripper action server is not ready.")
            return

        goal = GripperCommand.Goal()
        goal.command.position = (
            self.gripper_closed_position if msg.data else self.gripper_open_position
        )
        goal.command.max_effort = self.gripper_max_effort
        self.gripper_client.send_goal_async(goal)
        self.last_gripper_closed = msg.data
        action = "close" if msg.data else "open"
        self.get_logger().info(f"Gripper {action} command sent.")

    def control_loop(self):
        now = self.get_clock().now()
        stale = (
            self.last_target_time is None
            or (now - self.last_target_time).nanoseconds * 1e-9 > self.command_timeout
        )
        if not self.enabled or self.target is None or stale:
            self.filtered = [0.0] * 6
            self.publish_twist(self.filtered)
            return

        try:
            transform = self.tf_buffer.lookup_transform(
                self.base_frame,
                self.ee_frame,
                rclpy.time.Time(),
                timeout=Duration(seconds=0.02),
            ).transform
        except TransformException:
            self.publish_twist([0.0] * 6)
            return

        target_position = self.target.position
        current_position = transform.translation
        linear = clamp_norm(
            [
                self.linear_gain * (target_position.x - current_position.x),
                self.linear_gain * (target_position.y - current_position.y),
                self.linear_gain * (target_position.z - current_position.z),
            ],
            self.max_linear_speed,
        )

        angular = [0.0, 0.0, 0.0]
        if self.control_orientation:
            target_orientation = self.target.orientation
            current_orientation = transform.rotation
            angular_error = quaternion_error(
                [
                    target_orientation.x,
                    target_orientation.y,
                    target_orientation.z,
                    target_orientation.w,
                ],
                [
                    current_orientation.x,
                    current_orientation.y,
                    current_orientation.z,
                    current_orientation.w,
                ],
            )
            angular = clamp_norm(
                [self.angular_gain * value for value in angular_error],
                self.max_angular_speed,
            )

        desired = linear + angular
        alpha = self.filter_alpha
        self.filtered = [
            alpha * value + (1.0 - alpha) * previous
            for value, previous in zip(desired, self.filtered)
        ]
        self.publish_twist(self.filtered)

    def publish_twist(self, values):
        msg = TwistStamped()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = self.base_frame
        msg.twist.linear.x, msg.twist.linear.y, msg.twist.linear.z = values[:3]
        msg.twist.angular.x, msg.twist.angular.y, msg.twist.angular.z = values[3:]
        self.twist_pub.publish(msg)


def main():
    rclpy.init()
    node = PoseToTwistBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
