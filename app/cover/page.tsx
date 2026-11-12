'use client';

// A clean still of the robot for the slides: the tower alone, no panels, no orders claimed.
// Frame it with ?cam=x,y,z&fov=deg&shift=0.25&labels=0, then screenshot (scripts/cover.mjs does it at 4K).
// Set dressing (people, counters, the robot's face, lens blur) lives in components/coverScene.ts.

import * as THREE from 'three';
import TowerView from '../../components/TowerView';
import { CROWD, counters, dressRobot, lens, person } from '../../components/coverScene';

const vec = (q: URLSearchParams, k: string, d: number[]) => (q.get(k)?.split(',').map(Number) ?? d) as [number, number, number];
const ROBOT = new THREE.Vector3(1, -2, 0.75); // docked; the camera eases onto it

export default function Cover() {
  return (
    <main style={{ position: 'fixed', inset: 0, background: '#1b2633' }}>
      <TowerView
        style={{ minHeight: 0 }}
        maxPixelRatio={2}
        onScene={({ camera, controls, labels, scene, renderer, meshes }) => {
          const q = new URLSearchParams(location.search);
          const on = (k: string) => q.get(k) !== '0';
          camera.position.set(...vec(q, 'cam', [2.15, -3.05, 0.25]));
          camera.fov = Number(q.get('fov') ?? 34);
          // The camera follows the robot, so slide it sideways in the frame instead: shift=0.25
          // puts the robot at 75% across (negative: on the left), leaving the rest for the title.
          const shift = Number(q.get('shift') ?? -0.22);
          camera.setViewOffset(innerWidth, innerHeight, -shift * innerWidth, 0, innerWidth, innerHeight);
          camera.updateProjectionMatrix();
          controls.target.copy(ROBOT);
          controls.enableDamping = false;
          controls.update();
          for (const l of labels) l.visible = q.get('labels') === '1';

          // Daytime lobby: light backdrop, soft sky/floor bounce, a gentle warm rim on the robot.
          const bg = q.get('bg') ?? '#e4e9ee';
          scene.background = new THREE.Color(bg);
          scene.fog = new THREE.Fog(bg, Number(q.get('fogNear') ?? 6), Number(q.get('fogFar') ?? 20));
          scene.add(new THREE.HemisphereLight('#ffffff', '#d8cfc4', 0.85));
          const rim = new THREE.DirectionalLight('#ffc39a', 0.6);
          rim.position.set(3, 5, 0.6);
          scene.add(rim);
          scene.traverse((o) => { if (o instanceof THREE.AmbientLight) o.intensity = Number(q.get('ambient') ?? 0.7); });

          if (on('people')) CROWD.forEach(([x, y, f, look]) => scene.add(person(x, y, f, look)));
          if (on('props')) scene.add(counters());
          // Lens blur focused on the robot: the lobby stays readable but steps back.
          if (on('blur')) lens(renderer, scene, camera, () => camera.position.distanceTo(ROBOT), Number(q.get('aperture') ?? 0.0035), Number(q.get('maxblur') ?? 0.006));
          // The robot's meshes get their pose with the sim's first frames.
          setTimeout(() => {
            if (on('robot')) dressRobot(scene, meshes, ROBOT);
            document.body.dataset.ready = '1';
          }, 1500);
        }}
      />
    </main>
  );
}
