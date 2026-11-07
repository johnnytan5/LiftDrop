import { Barlow_Condensed, Public_Sans } from 'next/font/google';
import './globals.css';

const signage = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-signage' });
const text = Public_Sans({ subsets: ['latin'], variable: '--font-text' });

export const metadata = { title: 'LiftDrop', description: 'The shops downstairs, delivered by robot. Pay only for what you take.' };
export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${signage.variable} ${text.variable}`}>
      <body>{children}</body>
    </html>
  );
}
