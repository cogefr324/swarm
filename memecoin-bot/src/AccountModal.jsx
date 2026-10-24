import { useAuth } from './AuthContext';

export default function AccountModal({ onClose }) {
  const { user, signOut } = useAuth();

  async function handleSignOut() {
    await signOut();
    onClose();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#111a26',
          border: '1px solid #223247',
          borderRadius: 12,
          maxWidth: 400,
          width: '100%',
          padding: 24,
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Account</h2>
          <button onClick={onClose} style={{ padding: '4px 10px' }}>✕</button>
        </div>

        <div style={{ fontSize: 12, color: '#8296ad', marginBottom: 4 }}>Signed in as</div>
        <div style={{ fontSize: 15, marginBottom: 20, wordBreak: 'break-all' }}>{user?.email}</div>

        <div style={{ fontSize: 12, color: '#8296ad', marginBottom: 20 }}>
          Your paper balance, positions, and trade history are saved to this account and will be here
          whenever you log back in, on any device.
        </div>

        <button
          onClick={handleSignOut}
          style={{
            width: '100%',
            padding: 10,
            background: '#3a1717',
            color: '#ff5d6c',
            borderColor: '#ff5d6c',
            fontWeight: 'bold',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Log Out
        </button>
      </div>
    </div>
  );
}
