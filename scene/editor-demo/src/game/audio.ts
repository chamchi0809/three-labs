/**
 * Noises, synthesised.
 *
 * No samples, because a demo that ships audio files needs a licence for them and a loading screen to fetch
 * them, and neither is what this demo is about. An oscillator with a fast envelope is a blaster; a burst of
 * noise through a lowpass is a shotgun; the same burst, quieter and shorter, is a pellet hitting concrete.
 *
 * The context is created on the first sound rather than in the constructor: a browser will not start one
 * before a gesture, and the first sound here always follows the click that locked the pointer.
 */
import type { WeaponId } from "./weapons.ts";

export class Sfx {
  #ctx: AudioContext | null = null;
  #out: GainNode | null = null;
  #noise: AudioBuffer | null = null;

  /** the gun going off; each one is a different envelope over the same two ideas */
  fire(id: WeaponId): void {
    const ctx = this.#wake();
    if (!ctx) return;
    if (id === "shotgun") {
      this.#burst(0.28, 0.5, 900);
      this.#tone("square", 140, 55, 0.16, 0.25);
    } else if (id === "plasma") {
      this.#tone("sawtooth", 620, 240, 0.09, 0.16);
      this.#burst(0.05, 0.1, 3000);
    } else {
      this.#tone("square", 880, 300, 0.08, 0.14);
    }
  }

  /** a pellet landing on a monster, which has to be audible under nine of itself */
  hit(): void {
    this.#burst(0.05, 0.22, 2600);
    this.#tone("triangle", 320, 180, 0.05, 0.1);
  }

  kill(): void {
    this.#tone("sawtooth", 220, 40, 0.5, 0.22);
    this.#burst(0.35, 0.2, 700);
  }

  hurt(): void {
    this.#tone("square", 180, 90, 0.22, 0.2);
    this.#burst(0.12, 0.18, 500);
  }

  pickup(): void {
    this.#tone("sine", 620, 1180, 0.14, 0.18);
  }

  die(): void {
    this.#tone("sawtooth", 260, 30, 1.3, 0.26);
  }

  win(): void {
    // an arpeggio, which is the shortest thing that reads as "that was the last one"
    for (const [i, hz] of [523, 659, 784, 1046].entries()) {
      this.#tone("triangle", hz, hz, 0.22, 0.16, i * 0.09);
    }
  }

  dispose(): void {
    void this.#ctx?.close();
    this.#ctx = null;
    this.#out = null;
    this.#noise = null;
  }

  /** the context, made on demand; null if the browser has no audio to give */
  #wake(): AudioContext | null {
    if (this.#ctx) {
      // a tab that was backgrounded comes back suspended
      if (this.#ctx.state === "suspended") void this.#ctx.resume();
      return this.#ctx;
    }
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return null;
    this.#ctx = new Ctor();
    this.#out = this.#ctx.createGain();
    this.#out.gain.value = 0.32;
    this.#out.connect(this.#ctx.destination);
    return this.#ctx;
  }

  /** a pitch sliding from one frequency to another under a decaying envelope */
  #tone(shape: OscillatorType, from: number, to: number, span: number, gain: number, delay = 0): void {
    const ctx = this.#wake();
    if (!ctx || !this.#out) return;
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const level = ctx.createGain();
    osc.type = shape;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + span);
    level.gain.setValueAtTime(gain, at);
    level.gain.exponentialRampToValueAtTime(0.0001, at + span);
    osc.connect(level).connect(this.#out);
    osc.start(at);
    osc.stop(at + span + 0.02);
  }

  /** noise through a lowpass: everything percussive in the game is this with different numbers */
  #burst(span: number, gain: number, cutoff: number): void {
    const ctx = this.#wake();
    if (!ctx || !this.#out) return;
    // one second of noise, made once and replayed at different lengths
    if (!this.#noise) {
      const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.#noise = buffer;
    }
    const at = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.#noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    const level = ctx.createGain();
    level.gain.setValueAtTime(gain, at);
    level.gain.exponentialRampToValueAtTime(0.0001, at + span);
    source.connect(filter).connect(level).connect(this.#out);
    source.start(at);
    source.stop(at + span);
  }
}
