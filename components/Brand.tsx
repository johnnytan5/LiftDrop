// LiftDrop mark and the app's top bar: a lift car with a drop-arrow, and the building it serves.

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="cp-logo">
      <rect width="32" height="32" rx="9" fill="#f0643f" />
      <rect x="8" y="6.5" width="16" height="19" rx="3" fill="none" stroke="#fff" strokeWidth="2.2" />
      <path d="M16 10.5v8m-3.6-3.4L16 18.7l3.6-3.6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 25.5v-2.5h8v2.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="cp-brand">
      <Logo />
      <span className="cp-brand-name">LiftDrop</span>
      <span className="cp-brand-tower">Halden Tower</span>
    </div>
  );
}
