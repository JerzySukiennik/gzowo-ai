// js/globe/satmodel.js — tiny three.js viewer for the satellite panel.
// Renders a PROCEDURAL satellite (body + solar panels + dish + antenna) the user
// can orbit (drag) and zoom (wheel). No external model asset (100% free, offline),
// no OrbitControls bare-specifier (minimal inline controls). three.js is lazy-loaded
// only when a satellite panel opens. A `variant` hook lets famous sats differ later.

let THREE = null;
async function three() {
  if (THREE) return THREE;
  THREE = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js');
  return THREE;
}

/**
 * Mount a rotating satellite model into `container`. Returns a dispose() fn.
 * @param {HTMLElement} container
 * @param {{variant?:string}} [opts]
 * @returns {Promise<() => void>}
 */
export async function mountSatModel(container, opts = {}) {
  const T = await three();
  const w = () => container.clientWidth || 300;
  const h = () => container.clientHeight || 220;

  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w(), h());
  container.appendChild(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(45, w() / h(), 0.1, 100);
  let camDist = 6;
  camera.position.set(0, 1.5, camDist);
  camera.lookAt(0, 0, 0);

  scene.add(new T.AmbientLight(0xffffff, 0.55));
  const sun = new T.DirectionalLight(0xffffff, 1.1);
  sun.position.set(4, 5, 3);
  scene.add(sun);
  const rim = new T.DirectionalLight(0x88aaff, 0.4);
  rim.position.set(-4, -2, -3);
  scene.add(rim);

  const sat = new T.Group();

  // Body — wrapped foil look (gold-ish metal).
  const body = new T.Mesh(
    new T.BoxGeometry(1.1, 1.3, 1.1),
    new T.MeshStandardMaterial({ color: 0xc9a24b, metalness: 0.7, roughness: 0.35 })
  );
  sat.add(body);

  // Solar panels — two dark-blue wings on ±X with a subtle grid.
  const panelMat = new T.MeshStandardMaterial({ color: 0x1b2f6b, metalness: 0.5, roughness: 0.4, emissive: 0x0a1533, emissiveIntensity: 0.4 });
  for (const dir of [-1, 1]) {
    const arm = new T.Mesh(new T.BoxGeometry(0.9, 0.05, 0.05), new T.MeshStandardMaterial({ color: 0x888888, metalness: 0.6, roughness: 0.5 }));
    arm.position.set(dir * 1.0, 0, 0);
    sat.add(arm);
    const panel = new T.Mesh(new T.BoxGeometry(2.2, 0.04, 1.0), panelMat);
    panel.position.set(dir * 2.6, 0, 0);
    sat.add(panel);
    // panel grid lines
    const edges = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(2.2, 0.04, 1.0)), new T.LineBasicMaterial({ color: 0x3355aa }));
    edges.position.copy(panel.position);
    sat.add(edges);
  }

  // Dish antenna.
  const dish = new T.Mesh(
    new T.CylinderGeometry(0.5, 0.5, 0.12, 24, 1, true),
    new T.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.3, roughness: 0.6, side: T.DoubleSide })
  );
  dish.rotation.x = Math.PI / 2.6;
  dish.position.set(0, 0.9, 0.35);
  sat.add(dish);
  const feed = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.5), new T.MeshStandardMaterial({ color: 0x999999 }));
  feed.position.set(0, 1.05, 0.5);
  sat.add(feed);

  scene.add(sat);

  // ---- Minimal orbit controls (drag rotate + wheel zoom) --------------------
  let dragging = false, px = 0, py = 0, autoRot = true;
  const onDown = (e) => { dragging = true; autoRot = false; px = e.clientX; py = e.clientY; };
  const onUp = () => { dragging = false; };
  const onMove = (e) => {
    if (!dragging) return;
    sat.rotation.y += (e.clientX - px) * 0.01;
    sat.rotation.x += (e.clientY - py) * 0.01;
    px = e.clientX; py = e.clientY;
  };
  const onWheel = (e) => {
    e.preventDefault();
    camDist = Math.max(3, Math.min(14, camDist + Math.sign(e.deltaY) * 0.6));
    camera.position.setLength(camDist);
    camera.lookAt(0, 0, 0);
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  const onResize = () => { renderer.setSize(w(), h()); camera.aspect = w() / h(); camera.updateProjectionMatrix(); };
  window.addEventListener('resize', onResize);

  let raf = 0, alive = true;
  function loop() {
    if (!alive) return;
    if (autoRot) sat.rotation.y += 0.006;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  loop();

  return function dispose() {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('wheel', onWheel);
    window.removeEventListener('resize', onResize);
    try { renderer.dispose(); } catch (_e) { /* ignore */ }
    try { container.removeChild(renderer.domElement); } catch (_e) { /* ignore */ }
  };
}
