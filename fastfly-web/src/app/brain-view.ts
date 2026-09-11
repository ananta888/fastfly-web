import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const PALETTE = [
  0x4a4a4a, // ''          unannotated
  0xffd166, // ascending
  0x06d6a0, // central
  0xef476f, // descending
  0xff8c42, // endocrine
  0x118ab2, // motor
  0x8338ec, // optic
  0x3a86ff, // sensory
  0xf72585, // sensory_ascending
  0x9e2b25, // visual_centrifugal
  0x2ec4b6, // visual_projection
];

const MAX_ACTIVE = 5000;

@Component({
  selector: 'app-brain-view',
  template: '<div #canvasHost class="brain-host"></div>',
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }
      .brain-host {
        width: 100%;
        height: 100%;
      }
    `,
  ],
})
export class BrainView implements AfterViewInit, OnDestroy {
  @ViewChild('canvasHost', { static: true }) host!: ElementRef<HTMLDivElement>;

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private activePoints!: THREE.Points;
  private activePos!: Float32Array;
  private activeGeom!: THREE.BufferGeometry;
  private positions?: Float32Array;
  private raf = 0;

  setBrain(positions: Float32Array, classId: Uint8Array): void {
    this.positions = positions;

    const vertexColors = new Float32Array(positions.length);
    const nClasses = PALETTE.length;
    for (let i = 0; i < classId.length; i++) {
      const hex = PALETTE[classId[i] % nClasses];
      vertexColors[i * 3] = ((hex >> 16) & 0xff) / 255;
      vertexColors[i * 3 + 1] = ((hex >> 8) & 0xff) / 255;
      vertexColors[i * 3 + 2] = (hex & 0xff) / 255;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));

    const mat = new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
    });

    const neuro = new THREE.Points(geom, mat);
    this.scene.add(neuro);
  }

  setActive(indices: number[]): void {
    if (!this.positions || !this.activePos) return;
    const n = Math.min(indices.length, MAX_ACTIVE);
    for (let i = 0; i < n; i++) {
      const idx = indices[i] * 3;
      this.activePos[i * 3] = this.positions[idx];
      this.activePos[i * 3 + 1] = this.positions[idx + 1];
      this.activePos[i * 3 + 2] = this.positions[idx + 2];
    }
    this.activeGeom.setDrawRange(0, n);
    (this.activeGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  ngAfterViewInit(): void {
    const el = this.host.nativeElement;
    const width = el.clientWidth || 640;
    const height = el.clientHeight || 480;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x0d1117);
    el.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 100);
    this.camera.position.set(2.1, 1.4, 2.6);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 8;

    const grid = new THREE.GridHelper(4, 20, 0x1c2333, 0x161b26);
    this.scene.add(grid);

    this.activePos = new Float32Array(MAX_ACTIVE * 3);
    this.activeGeom = new THREE.BufferGeometry();
    this.activeGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.activePos, 3)
    );
    this.activeGeom.setDrawRange(0, 0);
    this.activePoints = new THREE.Points(
      this.activeGeom,
      new THREE.PointsMaterial({
        size: 5,
        sizeAttenuation: false,
        color: 0xffdc5c,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.scene.add(this.activePoints);

    window.addEventListener('resize', this.onResize);
    this.loop();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.host?.nativeElement?.firstChild?.remove();
  }

  private onResize = (): void => {
    if (!this.host?.nativeElement || !this.renderer || !this.camera) return;
    const width = this.host.nativeElement.clientWidth || 640;
    const height = this.host.nativeElement.clientHeight || 480;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.controls?.update();
    this.renderer?.render(this.scene, this.camera);
  };
}