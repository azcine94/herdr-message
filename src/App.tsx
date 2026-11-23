import { useEffect, useState } from 'react';
import { DynamicIsland } from './components/DynamicIsland';
import { MonitorSnapshot } from './types/monitor';

const INITIAL_SNAPSHOT: MonitorSnapshot = {
  connected: false,
  connectionHint: '正在连接 Herdr...',
  demoMode: false,
  pinned: false,
  tasks: [],
  quotas: [],
  latestAlert: null,
  updatedAt: Date.now(),
};

export default function App() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>(INITIAL_SNAPSHOT);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // 1s heartbeat for live ticking task timers
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const api = window.herdrIsland;
    if (!api) return;

    void api.getSnapshot().then((initial) => {
      setSnapshot(initial);
    });

    const unsubscribe = api.onSnapshot((next) => {
      setSnapshot(next);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div className="w-full h-full flex justify-center items-start pt-2 pointer-events-none">
      <DynamicIsland snapshot={snapshot} now={now} onSnapshotUpdate={setSnapshot} />
    </div>
  );
}
