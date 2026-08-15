'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraState, ShotSubject, PoseParams, MOVEMENT_TYPES, SUBJECT_COLORS, POSE_PRESETS } from './types';
import styles from './CameraEditor.module.css';

interface CameraEditorProps {
  value: CameraState;
  onChange: (state: CameraState) => void;
  ratio?: string;
  subjects?: ShotSubject[];
  onSubjectsChange?: (subjects: ShotSubject[]) => void;
}

function createTextSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 40);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.5, 0.4, 1);
  return sprite;
}

function applyPose(group: THREE.Group, params: PoseParams) {
  const deg2rad = (d: number) => (d * Math.PI) / 180;
  const parts = group.children;
  // Order: head(0), body(1), leftArm(2), rightArm(3), leftLeg(4), rightLeg(5), sprite(6)
  if (parts[0]) parts[0].rotation.x = deg2rad(params.head || 0);
  if (parts[1]) parts[1].rotation.x = deg2rad(params.torso || 0);
  if (parts[2]) parts[2].rotation.x = deg2rad(params.leftArm || 0);
  if (parts[3]) parts[3].rotation.x = deg2rad(params.rightArm || 0);
  if (parts[4]) parts[4].rotation.x = deg2rad(params.leftLeg || 0);
  if (parts[5]) parts[5].rotation.x = deg2rad(params.rightLeg || 0);
}

function buildHumanoid(subject: ShotSubject, index: number): THREE.Group {
  const color = subject.color || SUBJECT_COLORS[index % SUBJECT_COLORS.length];
  const mat = new THREE.MeshPhongMaterial({ color });
  const group = new THREE.Group();

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), mat.clone());
  head.position.set(0, 1.6, 0);
  group.add(head);

  // Body
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.7, 8), mat.clone());
  body.position.set(0, 1.1, 0);
  group.add(body);

  // Left Arm (pivot at shoulder)
  const lArm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 6), mat.clone());
  lArm.position.set(-0.25, 1.15, 0);
  group.add(lArm);

  // Right Arm
  const rArm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 6), mat.clone());
  rArm.position.set(0.25, 1.15, 0);
  group.add(rArm);

  // Left Leg
  const lLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 6), mat.clone());
  lLeg.position.set(-0.1, 0.35, 0);
  group.add(lLeg);

  // Right Leg
  const rLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 6), mat.clone());
  rLeg.position.set(0.1, 0.35, 0);
  group.add(rLeg);

  // Name label
  const sprite = createTextSprite(subject.label, color);
  sprite.position.set(0, 2.0, 0);
  group.add(sprite);

  // Position
  const pos = subject.position || { x: index * 2 - 2, y: 0, z: 0 };
  group.position.set(pos.x, pos.y, pos.z);

  // Rotation (Y-axis primarily)
  const rot = subject.rotation || { x: 0, y: 0, z: 0 };
  group.rotation.set(rot.x * Math.PI / 180, rot.y * Math.PI / 180, rot.z * Math.PI / 180);

  // Scale
  const s = subject.scale || 1;
  group.scale.set(s, s, s);

  // Pose
  const poseKey = subject.pose || 'standing';
  const poseParams = poseKey === 'custom' ? (subject.poseParams || {}) : (POSE_PRESETS[poseKey]?.params || {});
  applyPose(group, poseParams);

  return group;
}

export default function CameraEditor({ value, onChange, subjects, onSubjectsChange }: CameraEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    viewCamera: THREE.PerspectiveCamera;
    userCamera: THREE.PerspectiveCamera;
    cameraHelper: THREE.CameraHelper;
    targetMesh: THREE.Mesh;
    cameraMesh: THREE.Mesh;
    controls: OrbitControls;
    animId: number;
    subjectGroups: THREE.Group[];
  } | null>(null);

  const [localFov, setLocalFov] = useState(value.fov);
  const [localMovement, setLocalMovement] = useState(value.movementType);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const subjectsRef = useRef(subjects);
  subjectsRef.current = subjects;
  const onSubjectsChangeRef = useRef(onSubjectsChange);
  onSubjectsChangeRef.current = onSubjectsChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = 300;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x1e293b);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const grid = new THREE.GridHelper(20, 20, 0x475569, 0x334155);
    scene.add(grid);
    scene.add(new THREE.AxesHelper(3));
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    scene.add(new THREE.DirectionalLight(0xffffff, 0.4));

    const viewCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    viewCamera.position.set(12, 10, 12);
    viewCamera.lookAt(0, 0, 0);

    const userCamera = new THREE.PerspectiveCamera(value.fov, 16 / 9, 0.5, 20);
    userCamera.position.set(value.position.x, value.position.y, value.position.z);
    userCamera.lookAt(value.target.x, value.target.y, value.target.z);
    const cameraHelper = new THREE.CameraHelper(userCamera);
    scene.add(cameraHelper);

    const camMat = new THREE.MeshPhongMaterial({ color: 0x3b82f6, emissive: 0x1d4ed8 });
    const cameraMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16), camMat);
    cameraMesh.position.copy(userCamera.position);
    scene.add(cameraMesh);

    const tgtMat = new THREE.MeshPhongMaterial({ color: 0xef4444, emissive: 0xdc2626 });
    const targetMesh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), tgtMat);
    targetMesh.position.set(value.target.x, value.target.y, value.target.z);
    scene.add(targetMesh);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([cameraMesh.position, targetMesh.position]);
    const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: 0x94a3b8, dashSize: 0.3, gapSize: 0.2 }));
    scene.add(line);

    // Build subject humanoids
    const subjectGroups: THREE.Group[] = [];
    if (subjects && subjects.length > 0) {
      subjects.forEach((s, i) => {
        const g = buildHumanoid(s, i);
        scene.add(g);
        subjectGroups.push(g);
      });
    }

    const controls = new OrbitControls(viewCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 2, 0);

    // Raycaster interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let dragging: 'camera' | 'target' | number | null = null;

    function getAllSubjectMeshes(): THREE.Object3D[] {
      const meshes: THREE.Object3D[] = [];
      subjectGroups.forEach(g => {
        g.traverse(child => { if (child instanceof THREE.Mesh) meshes.push(child); });
      });
      return meshes;
    }

    function onPointerDown(e: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, viewCamera);

      // Check camera/target first
      const cameraHits = raycaster.intersectObjects([cameraMesh, targetMesh]);
      if (cameraHits.length > 0) {
        if (cameraHits[0].object === cameraMesh) dragging = 'camera';
        else dragging = 'target';
        controls.enabled = false;
        plane.constant = -(dragging === 'camera' ? cameraMesh.position.y : targetMesh.position.y);
        setSelectedIdx(null);
        return;
      }

      // Check subjects
      const subjectMeshes = getAllSubjectMeshes();
      const hits = raycaster.intersectObjects(subjectMeshes);
      if (hits.length > 0) {
        const hitObj = hits[0].object;
        for (let i = 0; i < subjectGroups.length; i++) {
          let found = false;
          subjectGroups[i].traverse(child => { if (child === hitObj) found = true; });
          if (found) {
            dragging = i;
            controls.enabled = false;
            plane.constant = -subjectGroups[i].position.y;
            setSelectedIdx(i);
            return;
          }
        }
      }

      setSelectedIdx(null);
    }

    function onPointerMove(e: PointerEvent) {
      if (dragging === null) return;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, viewCamera);

      const intersection = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, intersection)) return;

      if (dragging === 'camera') {
        cameraMesh.position.copy(intersection);
        userCamera.position.copy(intersection);
        userCamera.lookAt(targetMesh.position);
        cameraHelper.update();
        lineGeo.setFromPoints([cameraMesh.position, targetMesh.position]);
      } else if (dragging === 'target') {
        targetMesh.position.copy(intersection);
        userCamera.lookAt(targetMesh.position);
        cameraHelper.update();
        lineGeo.setFromPoints([cameraMesh.position, targetMesh.position]);
      } else if (typeof dragging === 'number') {
        const g = subjectGroups[dragging];
        if (g) {
          g.position.x = intersection.x;
          g.position.z = intersection.z;
        }
      }
    }

    function onPointerUp() {
      if (dragging === null) return;
      controls.enabled = true;

      if (dragging === 'camera' || dragging === 'target') {
        const newState: CameraState = {
          position: { x: +cameraMesh.position.x.toFixed(2), y: +cameraMesh.position.y.toFixed(2), z: +cameraMesh.position.z.toFixed(2) },
          target: { x: +targetMesh.position.x.toFixed(2), y: +targetMesh.position.y.toFixed(2), z: +targetMesh.position.z.toFixed(2) },
          fov: userCamera.fov,
          movementType: valueRef.current.movementType,
        };
        changeRef.current(newState);
      } else if (typeof dragging === 'number') {
        const subs = subjectsRef.current;
        if (subs && onSubjectsChangeRef.current) {
          const updated = [...subs];
          const g = subjectGroups[dragging];
          updated[dragging] = {
            ...updated[dragging],
            position: { x: +g.position.x.toFixed(2), y: +g.position.y.toFixed(2), z: +g.position.z.toFixed(2) },
          };
          onSubjectsChangeRef.current(updated);
        }
      }
      dragging = null;
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    let animId = 0;
    function animate() {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, viewCamera);
    }
    animate();

    sceneRef.current = { renderer, scene, viewCamera, userCamera, cameraHelper, targetMesh, cameraMesh, controls, animId, subjectGroups };

    return () => {
      cancelAnimationFrame(animId);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [subjects]);

  // Sync FOV
  useEffect(() => {
    if (!sceneRef.current) return;
    const { userCamera, cameraHelper } = sceneRef.current;
    userCamera.fov = localFov;
    userCamera.updateProjectionMatrix();
    cameraHelper.update();
  }, [localFov]);

  const handleFovChange = useCallback((fov: number) => {
    setLocalFov(fov);
    changeRef.current({ ...valueRef.current, fov });
  }, []);

  const handleMovementChange = useCallback((type: string) => {
    setLocalMovement(type);
    changeRef.current({ ...valueRef.current, movementType: type });
  }, []);

  // Subject property change
  const updateSubject = useCallback((idx: number, fields: Partial<ShotSubject>) => {
    const subs = subjectsRef.current;
    if (!subs || !onSubjectsChangeRef.current) return;
    const updated = [...subs];
    updated[idx] = { ...updated[idx], ...fields };
    onSubjectsChangeRef.current(updated);
  }, []);

  const selectedSubject = (selectedIdx !== null && subjects && subjects[selectedIdx]) ? subjects[selectedIdx] : null;

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className={styles.canvas} />
      <div className={styles.toolbar}>
        <label className={styles.toolLabel}>
          FOV
          <input type="range" min={20} max={120} value={localFov} onChange={e => handleFovChange(Number(e.target.value))} style={{ width: 80 }} />
          <span className={styles.toolValue}>{localFov}&deg;</span>
        </label>
        <label className={styles.toolLabel}>
          运镜
          <select value={localMovement} onChange={e => handleMovementChange(e.target.value)} className={styles.toolSelect}>
            {MOVEMENT_TYPES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <span className={styles.toolHint}>
          蓝球=相机 / 红球=目标 / 人形=主体(可拖拽)
        </span>
      </div>

      {selectedSubject && selectedIdx !== null && (
        <div className={styles.propsPanel}>
          <div className={styles.propsHeader}>
            <span className={styles.propsTitle}>{selectedSubject.label}</span>
            <button className={styles.propsClose} onClick={() => setSelectedIdx(null)}>&times;</button>
          </div>

          {/* Position */}
          <div className={styles.propsRow}>
            <span className={styles.propsLabel}>位置</span>
            {(['x', 'z'] as const).map(axis => (
              <label key={axis} className={styles.toolLabel}>
                {axis.toUpperCase()}
                <input
                  type="number"
                  step={0.5}
                  className={styles.propsInput}
                  value={selectedSubject.position?.[axis] ?? 0}
                  onChange={e => {
                    const pos = { ...(selectedSubject.position || { x: 0, y: 0, z: 0 }), [axis]: +e.target.value };
                    updateSubject(selectedIdx, { position: pos });
                  }}
                />
              </label>
            ))}
          </div>

          {/* Rotation Y */}
          <div className={styles.propsRow}>
            <span className={styles.propsLabel}>旋转</span>
            <label className={styles.toolLabel}>
              Y
              <input
                type="range" min={-180} max={180}
                className={styles.propsSliderWide}
                value={selectedSubject.rotation?.y ?? 0}
                onChange={e => {
                  const rot = { ...(selectedSubject.rotation || { x: 0, y: 0, z: 0 }), y: +e.target.value };
                  updateSubject(selectedIdx, { rotation: rot });
                }}
              />
              <span className={styles.toolValue}>{selectedSubject.rotation?.y ?? 0}&deg;</span>
            </label>
          </div>

          {/* Scale */}
          <div className={styles.propsRow}>
            <span className={styles.propsLabel}>缩放</span>
            <input
              type="range" min={50} max={200} step={10}
              className={styles.propsSliderWide}
              value={(selectedSubject.scale || 1) * 100}
              onChange={e => updateSubject(selectedIdx, { scale: +e.target.value / 100 })}
            />
            <span className={styles.toolValue}>{((selectedSubject.scale || 1) * 100).toFixed(0)}%</span>
          </div>

          {/* Color */}
          <div className={styles.propsRow}>
            <span className={styles.propsLabel}>颜色</span>
            <div className={styles.colorRow}>
              {SUBJECT_COLORS.map(c => (
                <div
                  key={c}
                  className={`${styles.colorSwatch} ${(selectedSubject.color || SUBJECT_COLORS[selectedIdx % SUBJECT_COLORS.length]) === c ? styles.colorSwatchActive : ''}`}
                  style={{ background: c }}
                  onClick={() => updateSubject(selectedIdx, { color: c })}
                />
              ))}
            </div>
          </div>

          {/* Pose Presets */}
          <div className={styles.propsRow}>
            <span className={styles.propsLabel}>姿势</span>
            <div className={styles.poseRow}>
              {Object.entries(POSE_PRESETS).map(([key, { label }]) => (
                <button
                  key={key}
                  className={`${styles.poseBtn} ${(selectedSubject.pose || 'standing') === key ? styles.poseBtnActive : ''}`}
                  onClick={() => updateSubject(selectedIdx, { pose: key, poseParams: POSE_PRESETS[key].params })}
                >
                  {label}
                </button>
              ))}
              <button
                className={`${styles.poseBtn} ${selectedSubject.pose === 'custom' ? styles.poseBtnActive : ''}`}
                onClick={() => updateSubject(selectedIdx, { pose: 'custom', poseParams: selectedSubject.poseParams || POSE_PRESETS.standing.params })}
              >
                自定义
              </button>
            </div>
          </div>

          {/* Custom Pose Sliders */}
          {selectedSubject.pose === 'custom' && (
            <div className={styles.poseSliders}>
              {([
                ['leftArm', '左臂'],
                ['rightArm', '右臂'],
                ['leftLeg', '左腿'],
                ['rightLeg', '右腿'],
                ['torso', '躯干'],
                ['head', '头部'],
              ] as [keyof PoseParams, string][]).map(([key, label]) => (
                <div key={key} className={styles.poseSliderItem}>
                  <span className={styles.poseSliderLabel}>{label}</span>
                  <input
                    type="range" min={-180} max={180}
                    className={styles.propsSlider}
                    value={selectedSubject.poseParams?.[key] ?? 0}
                    onChange={e => {
                      const params = { ...(selectedSubject.poseParams || {}), [key]: +e.target.value };
                      updateSubject(selectedIdx, { poseParams: params });
                    }}
                  />
                  <span className={styles.poseSliderValue}>{selectedSubject.poseParams?.[key] ?? 0}&deg;</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
