function log(msg) {
  const el = document.getElementById("log");
  if (el) el.textContent += msg + "\n";
}

// ==================== ROSBRIDGE WSS ==========================
const ROSBRIDGE_PROTOCOL = location.protocol === "https:" ? "wss:" : "ws:";
const ROSBRIDGE_URL = `${ROSBRIDGE_PROTOCOL}//${location.host}/rosbridge`;
let ws = null;
let teleopEnabled = false;
let wristOrigin = null;

function rosPublish(topic, msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ op: "publish", topic, msg }));
}

function connectWS() {
  if (ws && (
    ws.readyState === WebSocket.OPEN ||
    ws.readyState === WebSocket.CONNECTING
  )) return;

  ws = new WebSocket(ROSBRIDGE_URL);
  ws.onopen = () => {
    log("WS connected. Enable teleop, then start WebXR.");
    document.getElementById("enable-teleop").disabled = false;
    document.getElementById("disable-teleop").disabled = false;
    rosPublish("/vr/teleop_enabled", { data: teleopEnabled });
  };
  ws.onerror = e => log("WS error: " + e);
  ws.onclose = () => log("WS closed");
}

document.getElementById("enable-teleop").onclick = () => {
  teleopEnabled = true;
  wristOrigin = null;
  rosPublish("/vr/teleop_enabled", { data: true });
  log("Teleop enabled");
};

document.getElementById("disable-teleop").onclick = () => {
  teleopEnabled = false;
  wristOrigin = null;
  rosPublish("/vr/teleop_enabled", { data: false });
  log("Teleop disabled");
};

const XR_SESSION_MODE = "immersive-ar";
const HAND_POSITION_SCALE = 1.5;

// Connect before entering immersive mode so Enable Teleop remains clickable.
connectWS();

// ==================== ENTER MR ==========================
document.getElementById("enter-vr").onclick = async () => {
  log("Enter MR clicked");

  const session = await navigator.xr.requestSession(XR_SESSION_MODE, {
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["hand-tracking"]
  });

  log(`Enter MR OK (${session.environmentBlendMode})`);
  await session.end();
};

// ==================== START WEBXR ==========================
document.getElementById("start").onclick = async () => {
  log("Start clicked");

  connectWS();

  const session = await navigator.xr.requestSession(XR_SESSION_MODE, {
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["hand-tracking"]
  });

  log(`XR session created (${session.environmentBlendMode})`);

  session.addEventListener("end", () => {
    teleopEnabled = false;
    rosPublish("/vr/teleop_enabled", { data: false });
    log("XR ended; teleop disabled");
  });

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", {
    xrCompatible: true,
    alpha: true
  });
  await gl.makeXRCompatible();

  session.updateRenderState({
    baseLayer: new XRWebGLLayer(session, gl)
  });

  const refSpace = await session.requestReferenceSpace("local-floor");

  // ===== Shaders =====
  const vsSource = `
    attribute vec3 a_position;
    uniform mat4 u_projection;
    uniform mat4 u_view;
    void main(void){
      gl_Position = u_projection * u_view * vec4(a_position, 1.0);
      gl_PointSize = 15.0;
    }
  `;
  const fsSource = `
    void main(void){
      gl_FragColor = vec4(1.0,1.0,1.0,1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  const vs = compile(gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const a_position = gl.getAttribLocation(prog, "a_position");
  const u_projection = gl.getUniformLocation(prog, "u_projection");
  const u_view = gl.getUniformLocation(prog, "u_view");

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(a_position);
  gl.vertexAttribPointer(a_position, 3, gl.FLOAT, false, 0, 0);

  // ================= MAIN XR LOOP ====================
  session.requestAnimationFrame(function loop(t, frame) {
    const baseLayer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const pose = frame.getViewerPose(refSpace);
    if (!pose) return session.requestAnimationFrame(loop);

    let pts = [];
    let wristPose = null;
    let pinch = null;

    for (const src of session.inputSources) {
      if (!src.hand) continue;

      // collect joints (for visualization)
      for (const name of src.hand.keys()) {
        const joint = src.hand.get(name);
        const jp = frame.getJointPose(joint, refSpace);
        if (!jp) continue;

        pts.push(
          jp.transform.position.x,
          jp.transform.position.y,
          jp.transform.position.z
        );
      }

      // use one hand for teleop
      if (!wristPose) {
        const wrist = src.hand.get("wrist");
        const thumb = src.hand.get("thumb-tip");
        const index = src.hand.get("index-finger-tip");

        if (wrist) wristPose = frame.getJointPose(wrist, refSpace);

        if (thumb && index) {
          const tp = frame.getJointPose(thumb, refSpace);
          const ip = frame.getJointPose(index, refSpace);
          if (tp && ip) {
            const dx = tp.transform.position.x - ip.transform.position.x;
            const dy = tp.transform.position.y - ip.transform.position.y;
            const dz = tp.transform.position.z - ip.transform.position.z;
            pinch = Math.sqrt(dx*dx + dy*dy + dz*dz) < 0.03;
          }
        }
      }
    }

    // ========= Publish wrist pose to ROS2 /servo_node/pose_target ==========
    if (teleopEnabled && wristPose && ws && ws.readyState === WebSocket.OPEN) {
      const p = wristPose.transform.position;
      const q = wristPose.transform.orientation;

      if (!wristOrigin) {
        wristOrigin = { x: p.x, y: p.y, z: p.z };
        log("Wrist origin calibrated");
      }

      // ===== 座標系轉換（WebXR → MoveIt Servo）=====
      // WebXR: +X right, +Y up, +Z backward
      // MoveIt: +X forward, +Y left, +Z up (近似)
      //
      // 最低可行版本 → 只翻轉 Z，調整尺度與偏移
      const x = 0.4 - (p.z - wristOrigin.z) * HAND_POSITION_SCALE; // 前後
      const y = (p.x - wristOrigin.x) * HAND_POSITION_SCALE;       // 左右
      const z = 0.6 + (p.y - wristOrigin.y) * HAND_POSITION_SCALE; // 高度

      // ===== 送出 PoseStamped =====
      rosPublish("/panda_servo/pose_target", {
        header: {
          frame_id: "panda_link0",
          stamp: { sec: 0, nanosec: 0 }
        },
        pose: {
          position: { x, y, z },
          orientation: {
            x: q.x,
            y: q.y,
            z: q.z,
            w: q.w
          }
        }
      });
    }

    // ========= Publish pinch ==========
    if (pinch !== null) {
      rosPublish("/vr/gripper_cmd", { data: pinch });
    }

    // ========= Draw joints ==========
    if (pts.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.DYNAMIC_DRAW);
    }

    for (const view of pose.views) {
      const vp = baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      gl.uniformMatrix4fv(u_projection, false, view.projectionMatrix);
      gl.uniformMatrix4fv(u_view, false, view.transform.inverse.matrix);

      gl.drawArrays(gl.POINTS, 0, pts.length / 3);
    }

    session.requestAnimationFrame(loop);
  });
};
