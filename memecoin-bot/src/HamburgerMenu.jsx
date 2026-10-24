import { useState, useRef, useEffect } from 'react';

export default function HamburgerMenu({ onGoHome, onOpenGuide, onOpenAccount, onOpenPositions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', zIndex: 200, flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Menu"
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          padding: 0,
        }}
      >
        ☰
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 46,
            right: 0,
            minWidth: 180,
            background: '#111a26',
            border: '1px solid #223247',
            borderRadius: 8,
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
            overflow: 'hidden',
            zIndex: 200,
          }}
        >
          <MenuItem
            label="Home"
            onClick={() => {
              onGoHome();
              setOpen(false);
            }}
          />
          <MenuItem
            label="Guide: How to Use"
            onClick={() => {
              onOpenGuide();
              setOpen(false);
            }}
          />
          <MenuItem
            label="💼 Wallet (Positions)"
            onClick={() => {
              onOpenPositions();
              setOpen(false);
            }}
          />
          <a
            href="https://discord.gg/cgCyQ5EWVx"
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: 'none' }}
            onClick={() => setOpen(false)}
          >
            <MenuItem label="Discord ↗" />
          </a>
          <MenuItem
            label="Account"
            last
            onClick={() => {
              onOpenAccount();
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onClick, last }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '12px 16px',
        fontSize: 14,
        color: '#f3f4f6',
        cursor: 'pointer',
        borderBottom: last ? 'none' : '1px solid #222',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#162233')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </div>
  );
}
