import { useState, useRef, useEffect } from 'react';

export default function Header({ onGoHome, onShowGuide }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleMenuClick() {
    onGoHome();
    setOpen(false);
  }

  function handleGuideClick() {
    onShowGuide();
    setOpen(false);
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        maxWidth: 1300,
        margin: '0 auto',
        padding: '4px 4px 0',
      }}
    >
      <h1 style={{ margin: 0 }}>Swarm</h1>

      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Menu"
          style={{ fontSize: 20, padding: '6px 12px', lineHeight: 1 }}
        >
          ☰
        </button>

        {open && (
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: '110%',
              background: '#111a26',
              border: '1px solid #223247',
              borderRadius: 8,
              boxShadow: 'rgba(0, 0, 0, 0.4) 0 10px 15px -3px, rgba(0, 0, 0, 0.25) 0 4px 6px -2px',
              minWidth: 160,
              overflow: 'hidden',
              zIndex: 50,
              textAlign: 'left',
            }}
          >
            <button
              onClick={handleMenuClick}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderRadius: 0, background: 'transparent' }}
            >
              Menu
            </button>
            <a
              href="https://discord.gg/cgCyQ5EWVx"
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', color: 'inherit', textDecoration: 'none', borderTop: '1px solid #223247' }}
            >
              Discord
            </a>
            <button
              onClick={handleGuideClick}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderRadius: 0, background: 'transparent', borderTop: '1px solid #223247' }}
            >
              Guide
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
