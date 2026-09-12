import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { BrainView } from './brain-view';
import { LabView } from './lab-view';
import { WsService, WsMessage } from './ws.service';

const REALTIME_HOPS = 200;

@Component({
  selector: 'app-root',
  imports: [CommonModule, BrainView, LabView],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, AfterViewInit, OnDestroy {
  protected readonly mode = signal<'brain' | 'arena'>('brain');
  protected readonly connected = signal(false);
  protected readonly running = signal(false);

  protected readonly nNeurons = signal(0);
  protected readonly nSynapses = signal(0);
  protected readonly step = signal(0);

  protected readonly stepsPerSec = signal(0);
  protected readonly speedup = signal(0);
  protected readonly spikesPerStep = signal(0);
  protected readonly firingPct = signal(0);
  protected readonly meanVoltage = signal(0);

  protected readonly groupLabels = signal<string[]>([]);
  protected readonly groupRates = signal<number[]>([]);

  protected readonly stimuli = signal<string[]>([]);
  protected readonly selectedStimulus = signal('');

  protected readonly amplitude = signal(0.5);
  protected readonly noise = signal(0.4);

  protected readonly stimuliFull = signal<string[]>([]);
  protected readonly amplitudeS = signal(0.5);

  @ViewChild('brain') private set brainRef(view: BrainView | undefined) {
    this.brain = view;
    if (view && this.positions && this.classes) view.setBrain(this.positions, this.classes);
  }
  private brain?: BrainView;
  @ViewChild('lab') private lab?: LabView;

  private positions?: Float32Array;
  private classes?: Uint8Array;

  constructor(private ws: WsService, private zone: NgZone) {}

  ngOnInit(): void {
    this.ws.messages.subscribe((m) => this.onMessage(m));
    if (!this.ws.connected()) this.ws.connect();
    this.ws.send({ cmd: 'start' });
  }

  ngAfterViewInit(): void {
    this.loadPositions();
  }

  ngOnDestroy(): void {
    this.ws.close();
  }

  setMode(name: 'brain' | 'arena'): void {
    this.mode.set(name);
  }

  protected onMessage(m: WsMessage): void {
    switch (m.type) {
      case 'state':
        this.running.set(Boolean(m['running']));
        this.connected.set(true);
        break;
      case 'init': {
        const nNeurons = m['n_neurons'];
        const nSynapses = m['n_synapses'];
        if (typeof nNeurons === 'number') this.nNeurons.set(nNeurons);
        if (typeof nSynapses === 'number') this.nSynapses.set(nSynapses);
        const gl = m['group_labels'];
        if (Array.isArray(gl)) {
          this.groupLabels.set(gl as string[]);
          this.groupRates.set(new Array((gl as string[]).length).fill(0));
        }
        const stims = m['stimuli'];
        if (Array.isArray(stims) && (stims as string[]).length) {
          this.stimuli.set(stims as string[]);
          this.selectedStimulus.set((stims as string[])[0]);
        }
        break;
      }
      case 'metrics': {
        const mtr = m as Record<string, unknown>;
        if (typeof mtr['step'] === 'number') this.step.set(mtr['step'] as number);
        if (typeof mtr['steps_per_sec'] === 'number') {
          this.stepsPerSec.set(mtr['steps_per_sec'] as number);
          this.speedup.set((mtr['steps_per_sec'] as number) / REALTIME_HOPS);
        }
        if (typeof mtr['spike_count'] === 'number') {
          this.spikesPerStep.set((mtr['spike_count'] as number) / 200);
        }
        if (typeof mtr['firing_rate'] === 'number') {
          this.firingPct.set((mtr['firing_rate'] as number) * 100);
        }
        if (typeof mtr['mean_voltage'] === 'number') {
          this.meanVoltage.set(mtr['mean_voltage'] as number);
        }
        const grp = mtr['group_rates'];
        if (Array.isArray(grp)) {
          const rates = (grp as number[]).map((r) => r * 100);
          this.groupRates.set(rates);
        }
        break;
      }
    }
  }

  start(): void {
    this.ws.send({ cmd: 'start' });
  }

  pause(): void {
    this.ws.send({ cmd: 'pause' });
  }

  stepOnce(): void {
    this.ws.send({ cmd: 'step' });
  }

  applyStimulus(): void {
    const name = this.selectedStimulus();
    if (!name) return;
    this.ws.send({
      cmd: 'stimulus_preset',
      name,
      amplitude: this.amplitude(),
      noise_amp: this.noise(),
    });
  }

  clearStimulus(): void {
    this.ws.send({ cmd: 'clear_stimulus', name: this.selectedStimulus() });
  }

  noiseEvent(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value);
    this.noise.set(v);
    this.ws.send({ cmd: 'set_param', param: 'noise_amp', value: v });
  }

  stimulusChange(e: Event): void {
    this.selectedStimulus.set((e.target as HTMLSelectElement).value);
  }

  ampEvent(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value);
    this.amplitude.set(v);
  }

  fmt(x: number, decimals = 0): string {
    if (x >= 1_000_000) return (x / 1_000_000).toFixed(1) + 'M';
    if (x >= 1_000) return (x / 1_000).toFixed(1) + 'k';
    return x.toLocaleString('de-DE', { maximumFractionDigits: decimals });
  }

  barWidth(r: number): number {
    return Math.min(100, Math.max(0, Math.round(r * 100)));
  }

  loadPositions(): void {
    const base = document.baseURI || '/fastfly/';
    fetch(`${base}api/positions`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
      .then((j: { positions_b64?: string; classes?: { ids_b64?: string } }) => {
        if (!j.positions_b64 || !j.classes?.ids_b64) return;
        const pos = this.base64ToBytes(j.positions_b64);
        const cls = this.base64ToBytes(j.classes.ids_b64);
        this.positions = new Float32Array(pos.buffer);
        this.classes = new Uint8Array(cls.buffer);
        if (this.brain) this.brain.setBrain(this.positions, this.classes);
      })
      .catch((err) => console.error('Positionen laden fehlgeschlagen:', err));
  }

  private base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
}
