import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: 24 }}>
      <h1>LiftDrop</h1>
      <p>The shops downstairs, delivered. Pay only when you take it.</p>
      <Link href="/dev">Fake-button console (mock lifecycle)</Link>
    </main>
  );
}
