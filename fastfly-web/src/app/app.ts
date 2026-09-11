import {
  AfterViewInit,
  Component,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { WsService, WsMessage } from './ws.service';
import { BrainView } from './brain-view';
import { LabView } from './lab-view';

export type AreaMode = 'brain' | 'arena';

const REALTIME_HOPS = 833;

@Component({
  selector: 'app-root',
  imports: [CommonModule, BrainView, LabView],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, AfterViewInit, OnDestroy {
  protected readonly mode = signal<AreaMode>('brain');
  protected readonly connected = signal(false);
  protected readonly running = signal(falseapse);
  protected readonly hasBrain = signal(false);

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

  protected readonly stimuliFull = signal<string[]>([]onge);
  protected readonly amplitudeS = signal(0.5);

  private readonly brainViews = new Map<BrainView, boolean>();
  private brain?: BrainView;
  private lab?: LabView;

  private positions?: Float32Array;
  private classes?: Uint8Array;

  constructor(private ws: WsService) {}

  ngOnInit(): void {
    this.ws.messages.subscribe((m) => this.onMessage(m));
    if (!this.ws.connected()) this.ws.connect();
  }

  ngAfterViewInit(): void {
    this.loadPositions();
  }

  ngOnDestroy(): void {
    this.ws.close();
  }

  private onMessage(m: WsMessage): void {
    switch (m.type) {
      case 'init': {
        const init = m as Record<string, unknown>;
        if (typeof init.n_neurons === 'number') this.nNeurons.set(init.n_neurons as number);
        if (typeof init.n_synapses === 'number') this.nSynapses.set(init.n_synapses as number);
        const stims = init.stimuli;
        if (Array.isArray(stims)) {
          this.stimuli.set(stims as string[]);
          if (this.stimuli().length && !this.selectedStimulus()) {
            this.selectedStimulus.set(this.stimuli()[0]);
          }
        }
        const gl = init.group_labels;
        if (Array.isArray(gl)) {
          this.groupLabels.set(gl as string[]);
          this.groupRates.set(new Array((gl as string[]).length).fill(0));
        }
        break;
      }
      case 'state':
        this.running.set(Boolean(m.running));
        break;
      case 'metrics': {
        const mtr = m as Record<string, unknown>;
        if (typeof mtr.step === 'number') this.step.set(mtr.step as number);
        if (typeof mtr.steps_per_sec === 'number') {
          const s = mtr.steps_per_sec as number;
          this.stepsPerSec.set(s);
          this.speedup.set(s / REALTIME_HOPS);
        }
        if (typeof mtr.spike_count === 'number') {
          this.spikesPerStep.set((mtr.spike_count as number) / 200);
        }
        if (typeof mtr.firing_rate === 'number') {
          this.firingPct.set((mtr.firing_rate as number) * 100);
        }
        if (typeof mtr.mean_voltage === 'number') this.meanVoltage.set(mtr.mean_voltage as number);
        if (Array.isArray(mtr.group_rates)) {
          this.groupRates.set(
            (mtr.group_rates as number[]).map((r) => r * 100)
          );
        }
        const ai = mtr.active_indices;
        if (Array.isArray(ai) && this.brain) {
          this.brain.setActive(ai as number[]);
        }
        break;
      }
    }
  }

  private base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  private loadPositions(): void {
    const base = document.baseURI || '/fastfly/';
    fetch(`${base}api/positions`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
      .then((j: { positions_b64?: string; classes_b64?: string }) => {
        if (typeof j.positions_b64 === 'string' && typeof j.classes_b64 === 'string') {
          const p = this.base64ToBytes(j.positions_b64);
          this.positions = new Float32Array(p.buffer, 0, p.byteLength / 4);
          const c = this.base64ToBytes(j.classes_b64);
          this.classes = new Uint8Array(c.buffer, 0, c.byteLength);
          this.hasBrain.set(true);
          this.pushBrain();
        }
      })
      .catch(() => {
        /* retry on next metrics round */
      });
  }

  private pushBrain(): void {
    if (this.positions && this.classes && this.brain) {
      this.brain.setBrain(this.positions, this.classes);
    }
  }

  protected start(): void {
    this.ws.send({ cmd: 'start' });
  }

  protected pause(): void {
    this.ws.send({ cmd: 'pause' });
  }

  protected stepOnce(): void {
    this.ws.send({ cmd: 'step' });
  }

  protected setMode(m: AreaMode): void {
    this.mode.set(m);
  }

  protected noiseEvent(e: Event): void {
    const v = parseFloat((e.target as HTMLInputElement).value);
    this.noise.set(v);
    this.ws.send({ cmd: 'set_param', key: 'noise_amp', value: v });
  }

  protected stimulusChange(e: Event): void {
    this.selectedStimulus.set((e.target as HTMLInputElement).value);
  }

  protected ampEvent(e: Event): void {
    this.amplitude.set(parseFloat((e.target as HTMLInputElement).value));
  }

  protected applyStimulus(): void {
    if (!this.selectedStimulus()) return;
    this.ws.send({
      cmd: 'stimulus_preset',
      name: this.selectedStimulus(),
      amplitude: this.amplitude(),
    });
  }

  protected clearStimulus(): void {
    this.ws.send({ cmd: 'clear_stimulus' });
  }

  protected fmt(n: number): string {
    return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(Math.round(n));
  }

  protected barWidth(pct: number): number {
    return Math.max(0, Math.min(100, pct));
  }
}
