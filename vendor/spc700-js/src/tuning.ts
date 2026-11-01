/**
 * Turns pitch register values into actual notes.
 *
 * {@link analyzeSample} recovers each sample's base pitch from its waveform,
 * which lands within half a semitone but not exactly on it. The remaining
 * offset is pinned down by the music itself: a composer writes whole semitones,
 * so shifting a sample until the notes played through it sit on the grid is the
 * correction — and it needs no information from outside the dump.
 *
 * Until enough notes have been seen for a sample, its raw estimate is used. The
 * estimate is already close enough that the note name is usually right; the
 * refinement removes the cases that fall either side of a semitone boundary.
 */

import { analyzeSample, type BasePitch } from "./brr-analyzer.js";

/** Note-ons needed on one sample before its correction is trusted. */
const MIN_OBSERVATIONS = 8;
/** Cap on retained observations per sample. */
const MAX_OBSERVATIONS = 64;
/** A4 = 440 Hz = MIDI 69. */
const A4_HZ = 440;
const A4_MIDI = 69;
/** Pitch register value at which a sample plays back unshifted. */
const PITCH_ONE = 0x1000;

export class Tuning {
  private readonly base = new Map<number, BasePitch>();
  private readonly deviations = new Map<number, number[]>();
  private readonly correction = new Map<number, number>();

  constructor(
    private readonly ram: Uint8Array,
    private dirPage: number
  ) {}

  /** The sample directory can be re-pointed mid-track; keep up with it. */
  setDirectoryPage(page: number): void {
    if (page === this.dirPage) return;
    this.dirPage = page;
    this.base.clear();
    this.deviations.clear();
    this.correction.clear();
  }

  /** Base pitch of a sample, analysed on first use. */
  baseOf(srcn: number): BasePitch {
    let b = this.base.get(srcn);
    if (b == null) {
      b = analyzeSample(this.ram, this.dirPage, srcn);
      this.base.set(srcn, b);
    }
    return b;
  }

  /**
   * Note for a voice, as a MIDI number (69 = A4), or null when the sample has
   * no recoverable pitch.
   */
  noteOf(srcn: number, pitch: number): number | null {
    if (pitch <= 0) return null;
    const b = this.baseOf(srcn);
    if (b.hz <= 0) return null;
    const hz = b.hz * (pitch / PITCH_ONE);
    const midi = A4_MIDI + 12 * Math.log2(hz / A4_HZ);
    return midi - (this.correction.get(srcn) ?? 0);
  }

  /** Record a note-on so the sample's offset can be refined. */
  observe(srcn: number, pitch: number): void {
    if (pitch <= 0) return;
    const b = this.baseOf(srcn);
    if (b.hz <= 0) return;

    let list = this.deviations.get(srcn);
    if (list == null) {
      list = [];
      this.deviations.set(srcn, list);
    }
    if (list.length >= MAX_OBSERVATIONS) return;

    // Deviation is measured against the *uncorrected* estimate so the samples
    // stay comparable as more arrive.
    const hz = b.hz * (pitch / PITCH_ONE);
    const midi = A4_MIDI + 12 * Math.log2(hz / A4_HZ);
    list.push(midi - Math.round(midi));

    if (list.length >= MIN_OBSERVATIONS) {
      const sorted = [...list].sort((x, y) => x - y);
      this.correction.set(srcn, sorted[sorted.length >> 1]);
    }
  }

  /** Whether a sample's offset has been refined from observed notes yet. */
  isRefined(srcn: number): boolean {
    return this.correction.has(srcn);
  }
}

