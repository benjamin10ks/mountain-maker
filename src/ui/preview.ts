import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** three.js viewer that shows exactly the mesh that will be exported. */
export function createPreview(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2126);
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.up.set(0, 0, 1); // models are z-up, like printers
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(-1, 1, 1.2); // low from the north-west, like a shaded relief map
  scene.add(sun);
  // Raking fill from the front-left, so the nameplate (which faces south, away from the
  // sun) is lit and the walls of engraved or raised letters cast visible shading.
  const fill = new THREE.DirectionalLight(0xfff4e6, 1.1);
  fill.position.set(-1.2, -1, 0.35);
  scene.add(fill);

  const material = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.85 });
  const group = new THREE.Group();
  scene.add(group);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  // Radius of the model the camera was last framed for (0 = never), and the side it looks from.
  let framedFor = 0;
  let framedFrom = 0;

  return {
    /**
     * Non-indexed triangles centered on the origin in x/y, bottom at z=0. `viewFromDeg`
     * turns the default view from the front (south) counter-clockwise, e.g. 180 = back.
     */
    show(positions: Float32Array, normals: Float32Array, sizeMm: [number, number, number], viewFromDeg = 0) {
      for (const child of group.children) (child as THREE.Mesh).geometry.dispose();
      group.clear();

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      group.add(new THREE.Mesh(geometry, material));
      const [x, y, z] = sizeMm;

      // Keep the user's view for small tweaks, but reframe when the model changes size
      // enough that it would be cropped or tiny (e.g. a big exaggeration change).
      const r = Math.hypot(x, y, z) / 2;
      if (Math.abs(r - framedFor) > framedFor * 0.1 || viewFromDeg !== framedFrom) {
        const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 0.8; // spheres over-estimate a flat-ish tile
        controls.target.set(0, 0, z / 2);
        const a = (viewFromDeg * Math.PI) / 180;
        // From the south (turned to the nameplate side), 37° up.
        camera.position.set(dist * 0.8 * Math.sin(a), -dist * 0.8 * Math.cos(a), z / 2 + dist * 0.6);
        framedFor = r;
        framedFrom = viewFromDeg;
      }
    },
  };
}
