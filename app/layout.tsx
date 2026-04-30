import type { Metadata } from 'next';
import './globals.css';
import { TopNav } from '@/components/shared/TopNav';

export const metadata: Metadata = {
  title: 'Compass',
  description: 'Multi-agent RAG · Capital markets analyst workstation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
