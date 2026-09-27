# Quest 3 Panda Teleoperation Runbook

## Components

The runtime path is:

```text
Quest WebXR → ngrok HTTPS/WSS → server.js → rosbridge:9090
→ pose_to_twist_bridge.py → MoveIt Servo → ros2_control FakeSystem → RViz
```

The commands below use the development container name `ros2_vr_rebuilt`. Adjust
the container name and workspace paths for your environment.

## Start the Backend

Start the container:

```sh
docker start ros2_vr_rebuilt
```

Run the Panda FakeSystem, controllers, Servo, pose bridge, and RViz:

```sh
docker exec -it ros2_vr_rebuilt bash -lc \
  'cd /home/ubuntu/Desktop && source /opt/ros/humble/setup.bash && ros2 launch ./panda_servo_vr.launch.py'
```

In another terminal, start rosbridge:

```sh
docker exec -it ros2_vr_rebuilt bash -lc \
  'source /opt/ros/humble/setup.bash && ros2 launch rosbridge_server rosbridge_websocket_launch.xml'
```

After the Servo service appears, enable it:

```sh
docker exec ros2_vr_rebuilt bash -lc \
  'source /opt/ros/humble/setup.bash && ros2 service call /panda_servo/start_servo std_srvs/srv/Trigger "{}"'
```

Open RViz at `http://localhost:6080`. It uses `panda_live.rviz`, fixed frame
`panda_link0`, and the live `/robot_description`, TF, and `/joint_states` data.

## Start the Web Frontend

From the repository root, run:

```sh
node server.js
ngrok start teleop --config "<path-to-your-ngrok-config>,$PWD/ngrok.yml"
```

Open the ngrok HTTPS URL on Quest 3. Wait for `WS connected`, press
`Enable Teleop`, then press `Start WebXR`. The first tracked wrist pose becomes
the origin. Move slowly at first; pinch controls the gripper.

## Verify the Data Path

```sh
docker exec ros2_vr_rebuilt bash -lc \
  'source /opt/ros/humble/setup.bash && ros2 topic hz /panda_servo/pose_target'
docker exec ros2_vr_rebuilt bash -lc \
  'source /opt/ros/humble/setup.bash && ros2 topic echo /joint_states --once'
```

## Stop Everything

Disable teleoperation before stopping:

```sh
docker exec ros2_vr_rebuilt bash -lc \
  'source /opt/ros/humble/setup.bash && ros2 topic pub --once /vr/teleop_enabled std_msgs/msg/Bool "{data: false}"'
docker stop ros2_vr_rebuilt
pkill -f 'node server.js'
pkill -f 'ngrok start teleop'
```

Collision checking is disabled only for this FakeSystem visualization. Do not
reuse these speed or collision settings with a physical robot.
