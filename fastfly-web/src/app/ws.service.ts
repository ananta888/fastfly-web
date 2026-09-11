import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export type WsMessage = {
  type: string;
  [key: string]: unknown;
};

@Injectable({ providedIn: 'root' })
export class WsService {
  readonly messages = new Subject<WsMessage>();
  readonly connected = signal(false);

  private ws?: WebSocket;
  private closed = false;
  private retryDelay = 1500;

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const u = new URL('ws', document.baseURI);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(u.toString());
    } catch {
      this.connected.set(false);
      if (!this.closed) setTimeout(() => this.open(), this.retryDelay);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected.set(true);
      this.retryDelay = 1500;
    };
    ws.onmessage = (ev) => {
      try {
        this.messages.next(JSON.parse(ev.data) as WsMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      this.connected.set(false);
      if (!this.closed) setTimeout(() => this.open(), this.retryDelay);
    };
    ws.onerror = () => ws.close();
  }

  send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}