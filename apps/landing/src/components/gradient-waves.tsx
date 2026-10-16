'use client';

/*
 * Adapted from React Bits Gradient Waves by David Haz.
 * https://reactbits.dev/r/GradientWaves-TS-TW
 * Copyright (c) 2026 David Haz, MIT + Commons Clause.
 * Ships as part of the Ferry site. Not a standalone component.
 * See apps/landing/THIRD-PARTY.md.
 */

import { useEffect, useRef, type FC } from 'react';
import { Mesh, Program, Renderer, Triangle } from 'ogl';
import { cn } from '@/lib/utils';

export type GradientWavesDetail = 'low' | 'medium' | 'high';

export interface GradientWavesProps {
  horizonColor: string;
  waveColor: string;
  crestColor: string;
  speed?: number;
  amplitude?: number;
  waveScale?: number;
  waveRatio?: number;
  swell?: number;
  turbulence?: number;
  tilt?: number;
  zoom?: number;
  height?: number;
  fogDepth?: number;
  detail?: GradientWavesDetail;
  brightness?: number;
  opacity?: number;
  mouseInteraction?: boolean;
  parallaxStrength?: number;
  grain?: boolean;
  grainIntensity?: number;
  maxDpr?: number;
  className?: string;
}

interface FloatUniform {
  value: number;
}

interface VecUniform {
  value: Float32Array;
}

interface BoolUniform {
  value: boolean;
}

interface WaveUniforms {
  iTime: FloatUniform;
  iResolution: VecUniform;
  uSpeed: FloatUniform;
  uAmplitude: FloatUniform;
  uWaveScale: FloatUniform;
  uWaveRatio: FloatUniform;
  uSwell: FloatUniform;
  uTurbulence: FloatUniform;
  uTilt: FloatUniform;
  uZoom: FloatUniform;
  uHeight: FloatUniform;
  uFogDepth: FloatUniform;
  uSteps: FloatUniform;
  uBrightness: FloatUniform;
  uOpacity: FloatUniform;
  uGrain: FloatUniform;
  uGrainIntensity: FloatUniform;
  uMouse: VecUniform;
  uParallax: FloatUniform;
  uEnableMouse: BoolUniform;
  uHorizonColor: VecUniform;
  uWaveColor: VecUniform;
  uCrestColor: VecUniform;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const cleaned = hex.trim().replace(/^#/, '');
  if (cleaned.length !== 6) return [0, 0, 0];
  const r = Number.parseInt(cleaned.slice(0, 2), 16);
  const g = Number.parseInt(cleaned.slice(2, 4), 16);
  const b = Number.parseInt(cleaned.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return [0, 0, 0];
  return [r / 255, g / 255, b / 255];
};

const detailToSteps = (detail: GradientWavesDetail): number => {
  if (detail === 'low') return 40;
  if (detail === 'high') return 110;
  return 70;
};

const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uSteps;
uniform float uBrightness;
uniform float uOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec2 uMouse;
uniform float uParallax;
uniform bool uEnableMouse;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

const float MAX_DIST = 20000.0;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float plasma(vec3 r, vec2 freq, vec4 tc) {
  float mx = r.x + tc.x;
  mx += uSwell * sin((r.y + mx) / 20.0 + tc.y);
  float my = r.y - tc.z;
  my += uTurbulence * cos(r.x / 23.0 + tc.w);
  return r.z - (sin(mx * freq.x) * uAmplitude + sin(my * freq.y) * uAmplitude + uHeight);
}

float raymarch(vec3 pos, vec3 dir, vec2 freq, vec4 tc) {
  float dist = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= uSteps) break;
    float dscene = plasma(pos + dist * dir, freq, tc);
    if (abs(dscene) < 0.1) break;
    dist += 0.9 * dscene;
    if (!(abs(dist) < MAX_DIST)) return MAX_DIST;
  }
  return dist;
}

void main() {
  float T = iTime * uSpeed;
  vec2 freq = vec2(uWaveScale / 7.0, (uWaveScale * uWaveRatio) / 3.0);
  vec4 tc = vec4(T / 0.130, T / 0.810, T / 0.200, T / 0.710);
  float c, s;
  float vfov = (3.14159 / 2.3) / max(uZoom, 0.05);
  vec3 cam = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;

  vec3 dir = vec3(0.0, 0.0, -1.0);
  float ulen = length(uv);
  float xrot = vfov * ulen;
  c = cos(xrot); s = sin(xrot);
  dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  vec2 nuv = ulen > 1e-5 ? uv / ulen : vec2(1.0, 0.0);
  c = nuv.x; s = nuv.y;
  dir = mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0) * dir;
  c = cos(uTilt); s = sin(uTilt);
  dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;

  if (uEnableMouse) {
    float yaw = (uMouse.x - 0.5) * uParallax * 0.4;
    float pitch = (uMouse.y - 0.5) * uParallax * 0.4;
    c = cos(yaw); s = sin(yaw);
    dir = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c) * dir;
    c = cos(pitch); s = sin(pitch);
    dir = mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c) * dir;
  }

  float dist = raymarch(cam, dir, freq, tc);
  vec3 pos = cam + dist * dir;

  float t = clamp(uFogDepth / max(dist, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(pos.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 col = mix(uHorizonColor, body, t);
  col *= uBrightness;
  col = clamp(col, 0.0, 1.0);

  float alpha = clamp(t, 0.0, 1.0) * uOpacity;
  if (uGrain > 0.5) {
    float g = hash21(gl_FragCoord.xy + mod(iTime, 64.0) * 11.0);
    alpha += (g - 0.5) * uGrainIntensity;
  }
  alpha = clamp(alpha, 0.0, 1.0);
  fragColor = vec4(col * alpha, alpha);
}
`;

const GradientWaves: FC<GradientWavesProps> = ({
  horizonColor,
  waveColor,
  crestColor,
  speed = 0.32,
  amplitude = 2.2,
  waveScale = 0.55,
  waveRatio = 0.9,
  swell = 30,
  turbulence = 14,
  tilt = 1.08,
  zoom = 1.05,
  height = 5,
  fogDepth = 20,
  detail = 'medium',
  brightness = 0.82,
  opacity = 1,
  mouseInteraction = false,
  parallaxStrength = 0.22,
  grain = true,
  grainIntensity = 0.04,
  maxDpr = 1.5,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const uniformsRef = useRef<WaveUniforms | null>(null);
  const enableMouseRef = useRef(mouseInteraction);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new Renderer({
      webgl: 2,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      dpr: Math.min(window.devicePixelRatio || 1, maxDpr),
    });

    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    const canvas = gl.canvas;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);

    const uniforms: WaveUniforms = {
      iTime: { value: 0 },
      iResolution: { value: new Float32Array([1, 1]) },
      uSpeed: { value: speed },
      uAmplitude: { value: amplitude },
      uWaveScale: { value: waveScale },
      uWaveRatio: { value: waveRatio },
      uSwell: { value: swell },
      uTurbulence: { value: turbulence },
      uTilt: { value: tilt },
      uZoom: { value: zoom },
      uHeight: { value: height },
      uFogDepth: { value: fogDepth },
      uSteps: { value: detailToSteps(detail) },
      uBrightness: { value: brightness },
      uOpacity: { value: opacity },
      uGrain: { value: grain ? 1 : 0 },
      uGrainIntensity: { value: grainIntensity },
      uMouse: { value: new Float32Array([0.5, 0.5]) },
      uParallax: { value: parallaxStrength },
      uEnableMouse: { value: mouseInteraction },
      uHorizonColor: { value: new Float32Array(hexToRgb(horizonColor)) },
      uWaveColor: { value: new Float32Array(hexToRgb(waveColor)) },
      uCrestColor: { value: new Float32Array(hexToRgb(crestColor)) },
    };
    uniformsRef.current = uniforms;

    const geometry = new Triangle(gl);
    const program = new Program(gl, { vertex, fragment, uniforms });
    const mesh = new Mesh(gl, { geometry, program });

    const setSize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      renderer.setSize(w, h);
      const res = uniforms.iResolution.value;
      res[0] = gl.drawingBufferWidth;
      res[1] = gl.drawingBufferHeight;
      renderer.render({ scene: mesh });
    };

    const ro = new ResizeObserver(() => {
      setSize();
    });
    ro.observe(container);
    setSize();

    const currentMouse: [number, number] = [0.5, 0.5];
    const targetMouse: [number, number] = [0.5, 0.5];

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      targetMouse[0] = (event.clientX - rect.left) / rect.width;
      targetMouse[1] = 1 - (event.clientY - rect.top) / rect.height;
    };
    const onPointerLeave = () => {
      targetMouse[0] = 0.5;
      targetMouse[1] = 0.5;
    };
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);

    let raf = 0;
    let isVisible = true;
    let isPageVisible = !document.hidden;
    const t0 = performance.now();

    const loop = (t: number) => {
      uniforms.iTime.value = (t - t0) * 0.001;
      const tx = enableMouseRef.current ? targetMouse[0] : 0.5;
      const ty = enableMouseRef.current ? targetMouse[1] : 0.5;
      currentMouse[0] += 0.05 * (tx - currentMouse[0]);
      currentMouse[1] += 0.05 * (ty - currentMouse[1]);
      const mouse = uniforms.uMouse.value;
      mouse[0] = currentMouse[0];
      mouse[1] = currentMouse[1];
      renderer.render({ scene: mesh });
      raf = requestAnimationFrame(loop);
    };

    const tryStart = () => {
      if (isVisible && isPageVisible && raf === 0) raf = requestAnimationFrame(loop);
    };
    const tryStop = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        isVisible = entry?.isIntersecting ?? false;
        if (isVisible) tryStart();
        else tryStop();
      },
      { threshold: 0 },
    );
    io.observe(container);

    const onVisibility = () => {
      isPageVisible = !document.hidden;
      if (isPageVisible) tryStart();
      else tryStop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    tryStart();

    return () => {
      tryStop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      uniformsRef.current = null;
      if (canvas.parentNode === container) container.removeChild(canvas);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // Colors and motion settings are applied in the effect below. The context is created once.
  }, [maxDpr]);

  useEffect(() => {
    const uniforms = uniformsRef.current;
    if (!uniforms) return;
    enableMouseRef.current = mouseInteraction;
    uniforms.uSpeed.value = speed;
    uniforms.uAmplitude.value = amplitude;
    uniforms.uWaveScale.value = waveScale;
    uniforms.uWaveRatio.value = waveRatio;
    uniforms.uSwell.value = swell;
    uniforms.uTurbulence.value = turbulence;
    uniforms.uTilt.value = tilt;
    uniforms.uZoom.value = zoom;
    uniforms.uHeight.value = height;
    uniforms.uFogDepth.value = fogDepth;
    uniforms.uSteps.value = detailToSteps(detail);
    uniforms.uBrightness.value = brightness;
    uniforms.uOpacity.value = opacity;
    uniforms.uGrain.value = grain ? 1 : 0;
    uniforms.uGrainIntensity.value = grainIntensity;
    uniforms.uParallax.value = parallaxStrength;
    uniforms.uEnableMouse.value = mouseInteraction;
    const horizon = hexToRgb(horizonColor);
    const wave = hexToRgb(waveColor);
    const crest = hexToRgb(crestColor);
    uniforms.uHorizonColor.value[0] = horizon[0];
    uniforms.uHorizonColor.value[1] = horizon[1];
    uniforms.uHorizonColor.value[2] = horizon[2];
    uniforms.uWaveColor.value[0] = wave[0];
    uniforms.uWaveColor.value[1] = wave[1];
    uniforms.uWaveColor.value[2] = wave[2];
    uniforms.uCrestColor.value[0] = crest[0];
    uniforms.uCrestColor.value[1] = crest[1];
    uniforms.uCrestColor.value[2] = crest[2];
  }, [
    horizonColor,
    waveColor,
    crestColor,
    speed,
    amplitude,
    waveScale,
    waveRatio,
    swell,
    turbulence,
    tilt,
    zoom,
    height,
    fogDepth,
    detail,
    brightness,
    opacity,
    grain,
    grainIntensity,
    mouseInteraction,
    parallaxStrength,
  ]);

  return (
    <div ref={containerRef} className={cn('relative h-full w-full overflow-hidden', className)} />
  );
};

export default GradientWaves;
