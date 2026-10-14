import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CameraState } from '../../core/model/types';
import { SLAB_THICKNESS } from '../build/building-builder';
import { BuildingModel } from '../build/building-model';
import { createMaterials, disposeMaterials, MaterialSet } from './materials';
import { createBuildingObject, disposeObjectGeometry } from './mesh-factory';

const GROUND_SIZE = 4000;
/** Grade sits partway down the slab edge, so slabs read as poured concrete just above grade. */
const GROUND_LEVEL = -SLAB_THICKNESS / 2;
/** Default viewing direction: from the south-east, looking down at ~30°. */
const VIEW_DIRECTION = new Vector3(1, 0.85, 1.4).normalize();

/** Scene graph pieces that live for the lifetime of the viewer. */
interface Stage {
  scene: Scene;
  sun: DirectionalLight;
  ground: Mesh;
}

export interface Viewer3DOptions {
  /** Called whenever the camera pose changes (orbit, pan, zoom, programmatic moves). */
  onCameraChange?: (camera: CameraState) => void;
}

/**
 * Owns the WebGL renderer, camera, controls and lighting, and swaps building
 * objects in and out as the model changes. Rendering is on demand: frames are only
 * drawn when the camera moves, the model changes, or the canvas resizes.
 */
export class Viewer3D {
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly materials: MaterialSet;
  private readonly stage: Stage;
  private readonly resizeObserver: ResizeObserver;
  private building: Group | null = null;
  private lastBounds: BuildingModel['bounds'] | null = null;
  /** A framing request waiting for the canvas to have a real size. */
  private framePending = false;
  private frameHandle = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: Viewer3DOptions = {},
  ) {
    this.renderer = createRenderer();
    container.appendChild(this.renderer.domElement);

    this.materials = createMaterials();
    this.stage = createStage(this.materials);
    this.camera = new PerspectiveCamera(45, 1, 0.5, 6000);
    this.controls = createControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => {
      this.requestRender();
      this.options.onCameraChange?.(this.getCamera());
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /** Replaces the rendered building. The camera is left where it is. */
  setModel(model: BuildingModel): void {
    if (this.building) {
      this.stage.scene.remove(this.building);
      disposeObjectGeometry(this.building);
    }
    this.building = createBuildingObject(model, this.materials);
    this.stage.scene.add(this.building);
    this.lastBounds = model.bounds;
    fitSunToBounds(this.stage.sun, model.bounds);
    this.flushPendingFrame();
    this.requestRender();
  }

  /** Aims the camera at the current model, as soon as the canvas has a size. */
  requestFrame(): void {
    this.framePending = true;
    this.flushPendingFrame();
  }

  getCamera(): CameraState {
    const p = this.camera.position;
    const t = this.controls.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  /** Moves the camera to a saved pose, cancelling any pending auto-frame. */
  setCamera(state: CameraState): void {
    this.framePending = false;
    this.camera.position.set(...state.position);
    this.controls.target.set(...state.target);
    this.controls.update();
    this.requestRender();
  }

  /** Points the camera at the current model from the default viewing angle. */
  frameModel(): void {
    const b = this.lastBounds;
    if (!b) return;
    const center = new Vector3((b.x0 + b.x1) / 2, b.maxHeight * 0.35, (b.y0 + b.y1) / 2);
    const radius = Math.max(10, 0.5 * Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.maxHeight));
    const fov = (this.camera.fov * Math.PI) / 180;
    const fitFov = this.camera.aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect) : fov;
    const distance = (radius / Math.sin(fitFov / 2)) * 1.05;

    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
    this.options.onCameraChange?.(this.getCamera());
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    if (this.building) disposeObjectGeometry(this.building);
    this.stage.ground.geometry.dispose();
    disposeMaterials(this.materials);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.flushPendingFrame();
    this.requestRender();
  }

  private flushPendingFrame(): void {
    if (!this.framePending || this.container.clientWidth === 0 || this.container.clientHeight === 0) return;
    this.framePending = false;
    this.frameModel();
  }

  private requestRender(): void {
    if (this.frameHandle || this.disposed) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = 0;
      // With damping, update() keeps reporting changes until the camera settles.
      const moving = this.controls.update();
      this.renderer.render(this.stage.scene, this.camera);
      if (moving) this.requestRender();
    });
  }
}

// ===================================================================== setup helpers

function createRenderer(): WebGLRenderer {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  return renderer;
}

function createStage(materials: MaterialSet): Stage {
  const scene = new Scene();
  scene.background = new Color('#dde6ee');

  scene.add(new HemisphereLight('#f4f8ff', '#8a8f7a', 1.6));

  const sun = new DirectionalLight('#fff6e8', 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  const ground = new Mesh(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE), materials.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_LEVEL;
  ground.receiveShadow = true;
  scene.add(ground);

  return { scene, sun, ground };
}

/**
 * Standard orbit controls: left-drag orbits around the target, wheel zooms, and
 * shift+left-drag (or right-drag) pans. Panning moves the target with the camera,
 * so subsequent orbits pivot around the new target.
 */
function createControls(camera: PerspectiveCamera, dom: HTMLElement): OrbitControls {
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = 4;
  controls.maxDistance = 1500;
  controls.maxPolarAngle = Math.PI / 2 - 0.02; // stay above ground
  return controls;
}

/** Aims the sun's shadow camera so it tightly covers the building. */
function fitSunToBounds(sun: DirectionalLight, b: BuildingModel['bounds']): void {
  const center = new Vector3((b.x0 + b.x1) / 2, 0, (b.y0 + b.y1) / 2);
  const radius = Math.max(20, Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.maxHeight) * 0.75);
  sun.target.position.copy(center);
  sun.position.copy(center).add(new Vector3(-0.5, 1, 0.35).normalize().multiplyScalar(radius * 3));
  const cam = sun.shadow.camera;
  cam.left = -radius;
  cam.right = radius;
  cam.top = radius;
  cam.bottom = -radius;
  cam.near = 1;
  cam.far = radius * 6;
  cam.updateProjectionMatrix();
  sun.target.updateMatrixWorld();
}
