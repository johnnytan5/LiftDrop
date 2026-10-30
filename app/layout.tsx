export const metadata = { title: 'LiftDrop', description: 'The shops downstairs, delivered. Pay only when you take it.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f6f6f4', color: '#1a1a1a' }}>{children}</body>
    </html>
  );
}
