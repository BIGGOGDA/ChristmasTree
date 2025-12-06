import { useState, useMemo, useRef, useEffect, Suspense } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import {
  OrbitControls,
  Environment,
  PerspectiveCamera,
  shaderMaterial,
  Float,
  Stars,
  Sparkles,
  useTexture,
  Trail
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MathUtils } from 'three';
import * as random from 'maath/random';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

// --- 动态生成照片列表 ---
const TOTAL_NUMBERED_PHOTOS = 3;
const bodyPhotoPaths = [
  '/photos/top.jpg',
  ...Array.from({ length: TOTAL_NUMBERED_PHOTOS }, (_, i) => `/photos/${i + 1}.jpg`)
];

// --- 核心配置 (集中管理) ---
const CONFIG = {
  // 1. 界面与交互配置
  ui: {
    show: true, // 修改此处: false 则隐藏所有按钮和状态文字
  },

  // 2. 音频配置
  audio: {
    defaultPath: "/music/WinterAndYou.mp3",
    backupUrl: "https://webaudioapi.com/samples/audio-tag/chrono.mp3"
  },

  // 3. 数量配置 (方便调试性能)
  counts: {
    foliage: 15000,          // 树叶粒子数量
    photoOrnaments: 20,      // 悬挂的照片数量
    regularOrnaments: 600,   // 普通装饰物(球/礼物/灯泡)数量 - 原代码中硬编码为600
    elements: 400,           // (预留)
    lights: 600              // 缠绕的灯串节点数量
  },

  // 4. 视觉颜色配置
  colors: {
    emerald: '#004225',
    gold: '#FFD700',
    silver: '#ECEFF1',
    red: '#D32F2F',
    green: '#2E7D32',
    white: '#FFFFFF',
    warmLight: '#FFD54F',
    lights: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
    borders: ['#FFFAF0', '#F0E68C', '#E6E6FA', '#FFB6C1', '#98FB98', '#87CEFA', '#FFDAB9'],
    giftColors: ['#D32F2F', '#FFD700', '#1976D2', '#2E7D32'],
    candyColors: ['#FF0000', '#FFFFFF']
  },

  // 5. 树的形态配置
  tree: { height: 22, radius: 9 },

  // 6. 资源路径
  photos: {
    body: bodyPhotoPaths
  }
};

// --- Shader Material (Foliage) ---
const FoliageMaterial = shaderMaterial(
    { uTime: 0, uColor: new THREE.Color(CONFIG.colors.emerald), uProgress: 0 },
    `uniform float uTime; uniform float uProgress; attribute vec3 aTargetPos; attribute float aRandom;
  varying vec2 vUv; varying float vMix;
  float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
  void main() {
    vUv = uv;
    vec3 noise = vec3(sin(uTime * 1.5 + position.x), cos(uTime + position.y), sin(uTime * 1.5 + position.z)) * 0.15;
    float t = cubicInOut(uProgress);
    vec3 finalPos = mix(position, aTargetPos + noise, t);
    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = (60.0 * (1.0 + aRandom)) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vMix = t;
  }`,
    `uniform vec3 uColor; varying float vMix;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    vec3 finalColor = mix(uColor * 0.3, uColor * 1.2, vMix);
    gl_FragColor = vec4(finalColor, 1.0);
  }`
);
extend({ FoliageMaterial });

// --- Helper: Tree Shape ---
const getTreePosition = () => {
  const h = CONFIG.tree.height; const rBase = CONFIG.tree.radius;
  const y = (Math.random() * h) - (h / 2); const normalizedY = (y + (h/2)) / h;
  const currentRadius = rBase * (1 - normalizedY); const theta = Math.random() * Math.PI * 2;
  const r = Math.random() * currentRadius;
  return [r * Math.cos(theta), y, r * Math.sin(theta)];
};

// --- Component: Snow Effect ---
const SnowMaterial = shaderMaterial(
    { uTime: 0, uColor: new THREE.Color('#FFFFFF') },
    `
  uniform float uTime; attribute float aScale; attribute vec3 aVelocity; varying float vAlpha;
  void main() {
    vec3 pos = position;
    pos.y = 30.0 - mod(position.y + uTime * aVelocity.y, 60.0);
    pos.x += sin(uTime * aVelocity.x + position.y) * 0.5;
    pos.z += cos(uTime * aVelocity.z + position.y) * 0.5;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = (aScale * 300.0) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vAlpha = 0.8; 
  }
  `,
    `
  uniform vec3 uColor; varying float vAlpha;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    float glow = 1.0 - (r * 2.0); glow = pow(glow, 1.5);
    gl_FragColor = vec4(uColor, vAlpha * glow);
  }
  `
);
extend({ SnowMaterial });

const Snow = () => {
  const count = 2000;
  const meshRef = useRef<any>(null);
  const { positions, scales, velocities } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const scales = new Float32Array(count);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i*3] = (Math.random() - 0.5) * 80;
      positions[i*3+1] = (Math.random() - 0.5) * 60;
      positions[i*3+2] = (Math.random() - 0.5) * 80;
      scales[i] = Math.random() * 0.5 + 0.5;
      velocities[i*3] = Math.random() * 0.5 + 0.2;
      velocities[i*3+1] = Math.random() * 2.5 + 1.5;
      velocities[i*3+2] = Math.random() * 0.5 + 0.2;
    }
    return { positions, scales, velocities };
  }, []);
  useFrame((state) => { if (meshRef.current) meshRef.current.uTime = state.clock.elapsedTime; });
  return (
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-aScale" args={[scales, 1]} />
          <bufferAttribute attach="attributes-aVelocity" args={[velocities, 3]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <snowMaterial ref={meshRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>
  );
};

// --- Component: Foliage ---
const Foliage = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const materialRef = useRef<any>(null);
  const { positions, targetPositions, randoms } = useMemo(() => {
    const count = CONFIG.counts.foliage;
    const positions = new Float32Array(count * 3); const targetPositions = new Float32Array(count * 3); const randoms = new Float32Array(count);
    const spherePoints = random.inSphere(new Float32Array(count * 3), { radius: 25 }) as Float32Array;
    for (let i = 0; i < count; i++) {
      positions[i*3] = spherePoints[i*3]; positions[i*3+1] = spherePoints[i*3+1]; positions[i*3+2] = spherePoints[i*3+2];
      const [tx, ty, tz] = getTreePosition();
      targetPositions[i*3] = tx; targetPositions[i*3+1] = ty; targetPositions[i*3+2] = tz;
      randoms[i] = Math.random();
    }
    return { positions, targetPositions, randoms };
  }, []);
  useFrame((rootState, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime = rootState.clock.elapsedTime;
      const targetProgress = state === 'FORMED' ? 1 : 0;
      materialRef.current.uProgress = MathUtils.damp(materialRef.current.uProgress, targetProgress, 1.5, delta);
    }
  });
  return (
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-aTargetPos" args={[targetPositions, 3]} />
          <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <foliageMaterial ref={materialRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>
  );
};

// --- Component: Photo Ornaments ---
// --- Component: Photo Ornaments (Modified: 贴在树表面) ---
// --- Component: Photo Ornaments (Modified: 贴在树表面 + 防重叠) ---
const PhotoOrnaments = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const textures = useTexture(CONFIG.photos.body);
  const count = CONFIG.counts.photoOrnaments;
  const groupRef = useRef<THREE.Group>(null);

  const photoGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const borderGeometry = useMemo(() => new THREE.PlaneGeometry(1.08, 1.08), []);

  const data = useMemo(() => {
    const items: any[] = [];
    const maxRetries = 100; // 每个位置最大尝试次数，防止死循环
    const h = CONFIG.tree.height;
    const rBase = CONFIG.tree.radius;

    for (let i = 0; i < count; i++) {
      let validItem = null;

      // 尝试寻找一个不重叠的位置
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        // --- 1. 随机生成参数 ---
        const y = (Math.random() * h) - (h / 2);
        const normalizedHeight = (y + (h / 2)) / h;
        // 计算表面半径，+1.5 确保悬浮在叶子表面
        const surfaceRadius = rBase * (1 - normalizedHeight) + 1.5;
        const theta = Math.random() * Math.PI * 2;

        const targetPos = new THREE.Vector3(
            surfaceRadius * Math.cos(theta),
            y,
            surfaceRadius * Math.sin(theta)
        );

        // 随机大小 (先生成大小，以便计算碰撞半径)
        const isBig = Math.random() < 0.2;
        const scale = isBig ? 2.5 : 1.5 + Math.random() * 0.5;

        // --- 2. 碰撞检测 ---
        let collision = false;
        for (const existingItem of items) {
          const distance = targetPos.distanceTo(existingItem.targetPos);
          // 最小允许距离 = (新照片半径 + 旧照片半径) * 宽松系数
          // 这里的 0.7 是缩放系数，值越大间距越宽
          const minDistance = (scale + existingItem.scale) * 0.7;

          if (distance < minDistance) {
            collision = true;
            break; // 发现重叠，跳出当前检测，重新随机
          }
        }

        // --- 3. 如果无碰撞，记录数据并结束尝试 ---
        if (!collision) {
          const chaosPos = new THREE.Vector3((Math.random()-0.5)*70, (Math.random()-0.5)*70, (Math.random()-0.5)*70);
          const weight = 0.8 + Math.random() * 1.2;
          const borderColor = CONFIG.colors.borders[Math.floor(Math.random() * CONFIG.colors.borders.length)];
          const chaosRotation = new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);

          validItem = {
            chaosPos,
            targetPos,
            scale,
            weight,
            textureIndex: i % textures.length,
            borderColor,
            currentPos: chaosPos.clone(),
            chaosRotation,
            wobbleOffset: Math.random() * 10,
            wobbleSpeed: 0.2 + Math.random() * 0.2
          };
          break; // 成功找到位置，跳出重试循环
        }
      }

      // 如果找到了有效位置，加入列表
      if (validItem) {
        items.push(validItem);
      } else {
        console.warn(`无法为第 ${i} 张照片找到不重叠的位置，已跳过。`);
      }
    }
    return items;
  }, [textures, count]);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;

    groupRef.current.children.forEach((group, i) => {
      // 注意：这里 data 可能比 group.children 少（如果生成失败），加个保护
      const objData = data[i];
      if (!objData) return;

      const target = isFormed ? objData.targetPos : objData.chaosPos;

      objData.currentPos.lerp(target, delta * (isFormed ? 0.8 * objData.weight : 0.5));
      group.position.copy(objData.currentPos);

      if (isFormed) {
        // 朝向外侧
        group.lookAt(group.position.x * 2, group.position.y, group.position.z * 2);

        const wobbleX = Math.sin(time * objData.wobbleSpeed + objData.wobbleOffset) * 0.02;
        group.rotation.x += wobbleX;
        group.rotation.x -= 0.15; // 贴合斜坡
      } else {
        group.rotation.x = objData.chaosRotation.x + time * 0.2;
        group.rotation.y = objData.chaosRotation.y + time * 0.2;
        group.rotation.z = objData.chaosRotation.z;
      }
    });
  });

  return (
      <group ref={groupRef}>
        {data.map((obj, i) => (
            <group key={i} scale={[obj.scale, obj.scale, obj.scale]}>
              <group position={[0, 0, 0]}>
                <mesh geometry={photoGeometry} position={[0, 0, 0.01]}>
                  <meshStandardMaterial
                      map={textures[obj.textureIndex]}
                      roughness={0.4}
                      metalness={0}
                      emissive={CONFIG.colors.white}
                      emissiveMap={textures[obj.textureIndex]}
                      emissiveIntensity={0.2}
                      side={THREE.DoubleSide}
                  />
                </mesh>
                <mesh geometry={borderGeometry} position={[0, 0, -0.01]}>
                  <meshStandardMaterial color={obj.borderColor} roughness={0.8} metalness={0.1} side={THREE.DoubleSide} />
                </mesh>
                <Sparkles
                    position={[0, 0, 0.1]}
                    count={3}
                    scale={1}
                    size={4}
                    speed={0.2}
                    opacity={0.3}
                    color={CONFIG.colors.gold}
                />
              </group>
            </group>
        ))}
      </group>
  );
};

// --- Component: Ornaments ---
type OrnamentType = 'ball' | 'gift' | 'light';
interface InstanceData { chaosPos: THREE.Vector3; targetPos: THREE.Vector3; type: OrnamentType; color: THREE.Color; scale: number; speed: number; rotationOffset: THREE.Euler; }

const Ornaments = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const ballsRef = useRef<THREE.InstancedMesh>(null);
  const giftsRef = useRef<THREE.InstancedMesh>(null);
  const lightsRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // 使用 CONFIG 中的数量
  const count = CONFIG.counts.regularOrnaments;

  const { ballsData, giftsData, lightsData } = useMemo(() => {
    const _balls: InstanceData[] = []; const _gifts: InstanceData[] = []; const _lights: InstanceData[] = [];
    const treeHeight = CONFIG.tree.height; const maxRadius = CONFIG.tree.radius;
    const gold = new THREE.Color("#D4AF37"); const red = new THREE.Color("#8B0000"); const emerald = new THREE.Color("#004422"); const whiteGold = new THREE.Color("#F5E6BF");
    const palette = [gold, red, gold, whiteGold, emerald];
    for (let i = 0; i < count; i++) {
      const rnd = Math.random();
      let type: OrnamentType = 'ball'; if (rnd > 0.75) type = 'gift'; if (rnd > 0.90) type = 'light';
      const yNorm = Math.pow(Math.random(), 2.0); const y = - (treeHeight / 2) + (yNorm * treeHeight);
      const rScale = (1 - yNorm); const theta = y * 8 + Math.random() * Math.PI * 2;
      const r = (maxRadius * rScale * 0.9) + (Math.random() * 1.5);
      const targetPos = new THREE.Vector3(r * Math.cos(theta), y, r * Math.sin(theta));
      const cR = 40 + Math.random() * 30; const cTheta = Math.random() * Math.PI * 2; const cPhi = Math.acos(2 * Math.random() - 1);
      const chaosPos = new THREE.Vector3(cR * Math.sin(cPhi) * Math.cos(cTheta), cR * Math.sin(cPhi) * Math.sin(cTheta), cR * Math.cos(cPhi));
      let scale = 1; if (type === 'light') scale = 0.15 + Math.random() * 0.1; else if (type === 'gift') scale = 0.4 + Math.random() * 0.4; else scale = 0.3 + Math.random() * 0.4;
      const color = type === 'light' ? new THREE.Color("#FFFFAA") : palette[Math.floor(Math.random() * palette.length)];
      const data: InstanceData = { chaosPos, targetPos, type, color, scale, speed: 0.8 + Math.random() * 1.2, rotationOffset: new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, 0) };
      if (type === 'ball') _balls.push(data); else if (type === 'gift') _gifts.push(data); else _lights.push(data);
    }
    return { ballsData: _balls, giftsData: _gifts, lightsData: _lights };
  }, [count]);

  useEffect(() => {
    [{ ref: ballsRef, data: ballsData }, { ref: giftsRef, data: giftsData }, { ref: lightsRef, data: lightsData }].forEach(({ ref, data }) => {
      if (ref.current) { data.forEach((d, i) => { ref.current!.setColorAt(i, d.color); }); if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true; }
    });
  }, [ballsData, giftsData, lightsData]);

  useFrame((stateObj, delta) => {
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;
    const updateMesh = (ref: React.RefObject<THREE.InstancedMesh>, data: InstanceData[]) => {
      if (!ref.current) return;
      let needsUpdate = false;
      data.forEach((d, i) => {
        ref.current!.getMatrixAt(i, dummy.matrix); dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
        const dest = isFormed ? d.targetPos : d.chaosPos;
        const step = delta * d.speed * (isFormed ? 2.5 : 1.0);
        dummy.position.lerp(dest, step);
        if (isFormed && dummy.position.distanceTo(d.targetPos) < 1.0) { dummy.position.y += Math.sin(time * 3 + d.chaosPos.x) * 0.005; }
        if (d.type === 'gift') { dummy.rotation.x += delta * 0.5; dummy.rotation.y += delta * 0.2; } else { dummy.lookAt(0, dummy.position.y, 0); dummy.rotation.z += delta * 0.1; }
        dummy.scale.setScalar(d.scale);
        if (d.type === 'light') { const pulse = 1 + Math.sin(time * 6 + d.chaosPos.y) * 0.3; dummy.scale.multiplyScalar(pulse); }
        dummy.updateMatrix(); ref.current!.setMatrixAt(i, dummy.matrix); needsUpdate = true;
      });
      if (needsUpdate) ref.current.instanceMatrix.needsUpdate = true;
    };
    updateMesh(ballsRef, ballsData); updateMesh(giftsRef, giftsData); updateMesh(lightsRef, lightsData);
  });

  return (
      <>
        <instancedMesh ref={ballsRef} args={[undefined, undefined, ballsData.length]}><sphereGeometry args={[1, 32, 32]} /><meshStandardMaterial roughness={0.15} metalness={0.9} envMapIntensity={1.0} /></instancedMesh>
        <instancedMesh ref={giftsRef} args={[undefined, undefined, giftsData.length]}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial roughness={0.4} metalness={0.3} /></instancedMesh>
        <instancedMesh ref={lightsRef} args={[undefined, undefined, lightsData.length]}><sphereGeometry args={[1, 16, 16]} /><meshStandardMaterial emissive="white" emissiveIntensity={3.0} toneMapped={false} color="white" /></instancedMesh>
      </>
  );
};

// --- Component: Fairy Lights ---
const FairyLights = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.lights;
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.8, 8, 8), []);
  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2); const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.3; const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      const color = CONFIG.colors.lights[Math.floor(Math.random() * CONFIG.colors.lights.length)];
      const speed = 2 + Math.random() * 3;
      return { chaosPos, targetPos, color, speed, currentPos: chaosPos.clone(), timeOffset: Math.random() * 100 };
    });
  }, []);
  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED'; const time = stateObj.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 2.0);
      const mesh = child as THREE.Mesh; mesh.position.copy(objData.currentPos);
      const intensity = (Math.sin(time * objData.speed + objData.timeOffset) + 1) / 2;
      if (mesh.material) { (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = isFormed ? 3 + intensity * 4 : 0; }
    });
  });
  return (
      <group ref={groupRef}>
        {data.map((obj, i) => ( <mesh key={i} scale={[0.15, 0.15, 0.15]} geometry={geometry}>
          <meshStandardMaterial color={obj.color} emissive={obj.color} emissiveIntensity={0} toneMapped={false} />
        </mesh> ))}
      </group>
  );
};

// --- Component: Top Star ---
const TopStar = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const groupRef = useRef<THREE.Group>(null);
  const starShape = useMemo(() => {
    const shape = new THREE.Shape(); const outerRadius = 1.3; const innerRadius = 0.7; const points = 5;
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shape.moveTo(radius*Math.cos(angle), radius*Math.sin(angle)) : shape.lineTo(radius*Math.cos(angle), radius*Math.sin(angle));
    }
    shape.closePath(); return shape;
  }, []);
  const starGeometry = useMemo(() => new THREE.ExtrudeGeometry(starShape, { depth: 0.4, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3 }), [starShape]);
  const goldMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: CONFIG.colors.gold, emissive: CONFIG.colors.gold, emissiveIntensity: 1.5, roughness: 0.1, metalness: 1.0 }), []);
  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.5;
      const targetScale = state === 'FORMED' ? 1 : 0;
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 3);
    }
  });
  return (
      <group ref={groupRef} position={[0, CONFIG.tree.height / 2 + 1.8, 0]}>
        <Float speed={2} rotationIntensity={0.2} floatIntensity={0.2}><mesh geometry={starGeometry} material={goldMaterial} /></Float>
      </group>
  );
};

// --- Main Scene Experience ---
const Experience = ({ sceneState, rotationSpeed, tourMode }: { sceneState: 'CHAOS' | 'FORMED', rotationSpeed: number, tourMode: boolean }) => {
  const controlsRef = useRef<any>(null);

  useFrame((state, delta) => {
    if (controlsRef.current) {
      if (tourMode) {
        const currentAngle = controlsRef.current.getAzimuthalAngle();
        controlsRef.current.setAzimuthalAngle(currentAngle - delta * 0.6);
      } else {
        controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + rotationSpeed);
      }
      controlsRef.current.update();
    }
  });

  return (
      <>
        <PerspectiveCamera makeDefault position={[0, 6, 50]} fov={45} />
        <OrbitControls ref={controlsRef}  target={[0, -5, 0]} enablePan={false} enableZoom={true} minDistance={30} maxDistance={120} autoRotate={false} maxPolarAngle={Math.PI / 1.7} />

        <color attach="background" args={['#000300']} />
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
        <Environment preset="lobby" background={false} blur={0.8} />

        <ambientLight intensity={0.2} color="#003311" />
        <pointLight position={[30, 30, 30]} intensity={100} color={CONFIG.colors.warmLight} />
        <pointLight position={[-30, 10, -30]} intensity={50} color={CONFIG.colors.gold} />
        <pointLight position={[0, -20, 10]} intensity={30} color="#ffffff" />

        <group position={[0, -6, 0]}>
          <Foliage state={sceneState} />
          <Snow />
          <Suspense fallback={null}>
            <PhotoOrnaments state={sceneState} />
            <Ornaments state={sceneState} />
            <FairyLights state={sceneState} />
            <TopStar state={sceneState} />
          </Suspense>
          <Sparkles count={600} scale={50} size={8} speed={0.4} opacity={0.4} color={CONFIG.colors.silver} />
        </group>

        <EffectComposer>
          <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.1} intensity={1.5} radius={0.5} mipmapBlur />
          <Vignette eskil={false} offset={0.1} darkness={1.2} />
        </EffectComposer>
      </>
  );
};

// --- Gesture Controller ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GestureController = ({ onGesture, onMove, onStatus, debugMode }: any) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let gestureRecognizer: GestureRecognizer; let requestRef: number;
    const setup = async () => {
      onStatus("DOWNLOADING AI...");
      try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        gestureRecognizer = await GestureRecognizer.createFromOptions(vision, { baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task", delegate: "GPU" }, runningMode: "VIDEO", numHands: 1 });
        onStatus("REQUESTING CAMERA...");
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); onStatus("AI READY: SHOW HAND"); predictWebcam(); }
        } else { onStatus("ERROR: CAMERA PERMISSION DENIED"); }
      } catch (err: any) { onStatus(`ERROR: ${err.message || 'MODEL FAILED'}`); }
    };
    const predictWebcam = () => {
      if (gestureRecognizer && videoRef.current && canvasRef.current) {
        if (videoRef.current.videoWidth > 0) {
          const results = gestureRecognizer.recognizeForVideo(videoRef.current, Date.now());
          const ctx = canvasRef.current.getContext("2d");
          if (ctx && debugMode) {
            ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
            canvasRef.current.width = videoRef.current.videoWidth; canvasRef.current.height = videoRef.current.videoHeight;
            if (results.landmarks) for (const landmarks of results.landmarks) { const drawingUtils = new DrawingUtils(ctx); drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#FFD700", lineWidth: 2 }); drawingUtils.drawLandmarks(landmarks, { color: "#FF0000", lineWidth: 1 }); }
          } else if (ctx && !debugMode) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          if (results.gestures.length > 0) {
            const name = results.gestures[0][0].categoryName; const score = results.gestures[0][0].score;
            if (score > 0.4) { if (name === "Open_Palm") onGesture("CHAOS"); if (name === "Closed_Fist") onGesture("FORMED"); if (debugMode) onStatus(`DETECTED: ${name}`); }
            if (results.landmarks.length > 0) { const speed = (0.5 - results.landmarks[0][0].x) * 0.15; onMove(Math.abs(speed) > 0.01 ? speed : 0); }
          } else { onMove(0); if (debugMode) onStatus("AI READY: NO HAND"); }
        }
        requestRef = requestAnimationFrame(predictWebcam);
      }
    };
    setup(); return () => cancelAnimationFrame(requestRef);
  }, [onGesture, onMove, onStatus, debugMode]);
  return (
      <>
        <video ref={videoRef} style={{ opacity: debugMode ? 0.6 : 0, position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', zIndex: debugMode ? 100 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
        <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', height: debugMode ? 'auto' : '1px', zIndex: debugMode ? 101 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
      </>
  );
};

// --- App Entry ---
export default function GrandTreeApp() {
  const [sceneState, setSceneState] = useState<'CHAOS' | 'FORMED'>('CHAOS');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [aiStatus, setAiStatus] = useState("INITIALIZING...");
  const [debugMode, setDebugMode] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tourMode, setTourMode] = useState(false);

  // 音乐源状态: 使用 CONFIG 中的默认路径
  const [musicSrc, setMusicSrc] = useState(CONFIG.audio.defaultPath);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const toggleMusic = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.warn("本地文件播放失败，切换到在线备份:", error);
            // 失败时切换到 CONFIG 中的在线备份
            if (musicSrc !== CONFIG.audio.backupUrl) {
              setMusicSrc(CONFIG.audio.backupUrl);
              setTimeout(() => audioRef.current?.play(), 100);
            }
          });
        }
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const objectUrl = URL.createObjectURL(file);
      setMusicSrc(objectUrl);
      setIsPlaying(true);
      setTimeout(() => {
        if (audioRef.current) audioRef.current.play();
      }, 100);
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  return (
      <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>

        <audio
            ref={audioRef}
            loop
            src={musicSrc}
            onError={(e) => {
              console.log("Audio load error, switching to backup.");
              if (musicSrc !== CONFIG.audio.backupUrl) setMusicSrc(CONFIG.audio.backupUrl);
            }}
        />

        <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept="audio/mp3,audio/wav,audio/mpeg"
            onChange={handleFileChange}
        />

        <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
          <Canvas dpr={[1, 2]} gl={{ toneMapping: THREE.ReinhardToneMapping }} shadows>
            <Experience sceneState={sceneState} rotationSpeed={rotationSpeed} tourMode={tourMode} />
          </Canvas>
        </div>

        <GestureController onGesture={setSceneState} onMove={setRotationSpeed} onStatus={setAiStatus} debugMode={debugMode} />

        {/* 仅当 CONFIG.ui.show 为 true 时显示 UI */}
        {CONFIG.ui.show && (
            <>
              {/* 顶部按钮 UI */}
              <div style={{ position: 'absolute', top: '30px', right: '40px', zIndex: 20, display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <button onClick={toggleMusic} title={isPlaying ? "Pause Music" : "Play Music"} style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #FFD700', color: '#FFD700', borderRadius: '50%', width: '50px', height: '50px', fontSize: '20px', cursor: 'pointer', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s ease' }}>{isPlaying ? '⏸' : '🎵'}</button>
                <button onClick={triggerFileSelect} title="Change Music (Select MP3)" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #ECEFF1', color: '#ECEFF1', borderRadius: '50%', width: '50px', height: '50px', fontSize: '20px', cursor: 'pointer', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s ease' }}>📂</button>
                <button onClick={() => setTourMode(!tourMode)} title="Tour Mode (Auto Rotate)" style={{ background: tourMode ? 'rgba(255, 215, 0, 0.3)' : 'rgba(0,0,0,0.4)', border: '1px solid #FFD700', color: '#FFD700', borderRadius: '50%', width: '50px', height: '50px', fontSize: '20px', cursor: 'pointer', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s ease' }}>{tourMode ? '🎡' : '👀'}</button>
              </div>

              {/* 播放状态文字 */}
              {isPlaying && (
                  <div style={{ position: 'absolute', top: '35px', right: '110px', color: '#FFD700', fontFamily: 'monospace', textShadow: '0 0 4px #000', pointerEvents: 'none', textAlign: 'right' }}>
                    Playing: {musicSrc.startsWith('blob:') ? "Local File" : musicSrc.split('/').pop()}
                    <div style={{ fontSize: '10px', opacity: 0.7 }}>Sound On</div>
                  </div>
              )}

              {/* AI 状态文字 (左上角) - 只有在显示 UI 时才显示 */}
              <div style={{ position: 'absolute', top: '10px', left: '10px', color: '#5c1800', fontFamily: 'monospace', zIndex: 10, pointerEvents: 'none', background: 'rgba(0,0,0,0.5)', padding: '5px 10px', borderRadius: '4px',fontSize: '10px', opacity: 0.7  }}>
                STATUS: {aiStatus}
              </div>
            </>
        )}
      </div>
  );
}