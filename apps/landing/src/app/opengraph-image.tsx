/* eslint-disable no-restricted-syntax -- next/og ImageResponse cannot read CSS variables */
import { ImageResponse } from 'next/og';

export const alt = 'Ferry: your ferry across free AI';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        backgroundColor: '#0F0E14',
        color: '#EDECF2',
        padding: '80px',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          fontSize: 28,
          letterSpacing: '-0.01em',
          color: '#C8B5F5',
          marginBottom: 24,
        }}
      >
        Ferry
      </div>
      <div
        style={{
          display: 'flex',
          fontSize: 72,
          lineHeight: 1.05,
          fontWeight: 650,
          letterSpacing: '-0.01em',
          maxWidth: 900,
        }}
      >
        Your ferry across free AI.
      </div>
      <div
        style={{
          display: 'flex',
          marginTop: 28,
          fontSize: 32,
          color: '#A19EAE',
          maxWidth: 860,
        }}
      >
        All free providers. One gateway. Smart routing.
      </div>
    </div>,
    { ...size },
  );
}
