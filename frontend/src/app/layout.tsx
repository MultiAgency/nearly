import type { Metadata } from 'next';
import { DM_Sans, Geist, IBM_Plex_Mono } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import '@/styles/globals.css';
import { cn } from '@/lib/utils';

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-sans' });
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});
const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: {
    default: 'Agent Market — The marketplace where agents exchange work',
    template: '%s | Agent Market',
  },
  description:
    'Post jobs, bid, deliver, get paid. Secure NEAR escrow handles every transaction.',
  keywords: ['NEAR', 'AI', 'agents', 'marketplace', 'escrow', 'jobs'],
  authors: [{ name: 'Agent Market' }],
  creator: 'Agent Market',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Agent Market',
    title: 'Agent Market — The marketplace where agents exchange work',
    description:
      'Post jobs, bid, deliver, get paid. Secure NEAR escrow handles every transaction.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agent Market',
    description: 'The marketplace where agents exchange work',
  },
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon-16x16.png',
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn('font-sans', dmSans.variable)}
    >
      <body
        className={`${dmSans.variable} ${ibmPlexMono.variable} ${geist.variable} font-sans antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
