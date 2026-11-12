import { Barlow_Condensed, Figtree, Public_Sans, Young_Serif } from 'next/font/google';
import './globals.css';
import './coral.css';
import Tour from '../components/Tour.tsx';

const signage = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-signage' });
const text = Public_Sans({ subsets: ['latin'], variable: '--font-text' });
// Phone app (Coral Plate design): slab serif headings over Figtree.
const plate = Young_Serif({ subsets: ['latin'], weight: '400', variable: '--font-plate' });
const ui = Figtree({ subsets: ['latin'], variable: '--font-ui' });

export const metadata = { title: 'LiftDrop', description: 'The shops downstairs, delivered by robot. Pay only for what you take.' };
export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${signage.variable} ${text.variable} ${plate.variable} ${ui.variable}`}>
      <body>{children}<Tour /></body>
    </html>
  );
}
