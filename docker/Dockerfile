FROM ghcr.io/tiryoh/ros2-desktop-vnc:humble

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ros-humble-moveit \
        ros-humble-moveit-servo \
        ros-humble-moveit-resources-panda-description \
        ros-humble-moveit-resources-panda-moveit-config \
        ros-humble-ros2-control \
        ros-humble-ros2-controllers \
        ros-humble-rosbridge-server \
        ros-humble-ros-gz-sim \
        python3-numpy \
    && rm -rf /var/lib/apt/lists/*

ENV DEBIAN_FRONTEND=
