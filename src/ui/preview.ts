import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TerrainMesh } from '../core/mesh';

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

  // Radius of the model the camera was last framed for; 0 = never framed.
  let framedFor = 0;

  return {
    show(mesh: TerrainMesh) {
      for (const child of group.children) (child as THREE.Mesh).geometry.dispose();
      group.clear();

      // Smooth normals on the terrain, flat normals on the walls and bottom, so the
      // edges don't smear. Both share the same position buffer.
      const position = new THREE.BufferAttribute(mesh.positions, 3);
      const top = new THREE.BufferGeometry();
      top.setAttribute('position', position);
      top.setIndex(new THREE.BufferAttribute(mesh.indices.subarray(0, mesh.topIndexCount), 1));
      top.computeVertexNormals();

      const sidesIndexed = new THREE.BufferGeometry();
      sidesIndexed.setAttribute('position', position);
      sidesIndexed.setIndex(new THREE.BufferAttribute(mesh.indices.subarray(mesh.topIndexCount), 1));
      const sides = sidesIndexed.toNonIndexed();
      sides.computeVertexNormals();

      const [x, y, z] = mesh.sizeMm;
      group.add(new THREE.Mesh(top, material), new THREE.Mesh(sides, material));
      group.position.set(-x / 2, -y / 2, 0);

      // Keep the user's view for small tweaks, but reframe when the model changes size
      // enough that it would be cropped or tiny (e.g. a big exaggeration change).
      const r = Math.hypot(x, y, z) / 2;
      if (Math.abs(r - framedFor) > framedFor * 0.1) {
        const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 0.8; // spheres over-estimate a flat-ish tile
        controls.target.set(0, 0, z / 2);
        camera.position.set(0, -dist * 0.8, z / 2 + dist * 0.6); // from the south, 37° up
        framedFor = r;
      }
    },
  };
}
