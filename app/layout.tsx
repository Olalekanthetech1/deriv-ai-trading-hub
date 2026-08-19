import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans } from 'next/font/google';
import { buildFaviconUri } from '@/lib/build-favicon-uri';
import { getLogoSrc } from '@/lib/get-logo-src';
import { inter, FONT_CLASS_MAP } from '@/lib/fonts';
import { TemplateLayout } from '@/components/custom/template-layout';
import { LogoSrcProvider } from '@/components/custom/logo-src-provider';
import './globals.css';
import '@deriv-com/smartcharts-champion/dist/smartcharts.css';
import './custom.css';

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

// SmartCharts declares `font-family: IBM Plex Sans, sans-serif` internally.
// Loading the font here makes it available to those declarations so the chart
// renders with its intended typeface instead of falling back to the system
// sans-serif.  We apply the variable to <body> so the @font-face rules are
// emitted; SmartCharts resolves the family name automatically.
const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
});

export function generateMetadata(): Metadata {
  const faviconUri = buildFaviconUri();
  const appName = process.env.NEXT_PUBLIC_DERIV_APP_NAME || 'Deriv Rise/Fall Trading App';
  return {
    title: appName,
    description: 'A white-label algorithmic trading application powered by Deriv',
    appleWebApp: {
      capable: true,
      statusBarStyle: 'black-translucent',
      title: 'Deriv Trader',
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      icon: faviconUri || '/icons/icon-192x192.png',
      apple: '/icons/apple-touch-icon.png',
    },
  };
}

const fontClass =
  FONT_CLASS_MAP[process.env.NEXT_PUBLIC_FONT_FAMILY ?? 'Inter'] ??
  inter.className;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const logoSrc = getLogoSrc();
  return (
    <html lang="en" className="h-full lg:h-auto" suppressHydrationWarning>
      <body
        className={`${fontClass} ${ibmPlexSans.variable} bg-background flex min-h-dvh flex-col overflow-hidden max-lg:h-dvh max-lg:overflow-hidden lg:block lg:h-auto lg:min-h-screen lg:overflow-x-hidden lg:overflow-y-auto`}
      >
        <TemplateLayout>
          <LogoSrcProvider logoSrc={logoSrc}>{children}</LogoSrcProvider>
        </TemplateLayout>
      </body>
    </html>
  );
}
