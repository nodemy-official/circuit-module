import type { Preview } from '@storybook/react-vite';
import { createElement, type PropsWithChildren, useLayoutEffect } from 'react';
import '../src/ui/styles.css';
import './preview.css';

function ThemePreview({ children, theme, isCanvas }: PropsWithChildren<{
  theme: 'light' | 'dark';
  isCanvas: boolean;
}>) {
  useLayoutEffect(() => {
    if (!isCanvas) { return; }
    document.documentElement.dataset.theme = theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [theme, isCanvas]);
  return createElement('div', {
    className: 'circuit-theme storybook-theme',
    'data-theme': theme,
  }, children);
}

const preview: Preview = {
  tags: ['autodocs'],
  globalTypes: {
    theme: {
      description: 'カラーテーマ',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: ['light', 'dark'],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'light',
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
      return createElement(ThemePreview, { theme, isCanvas: context.viewMode === 'story' }, createElement(Story));
    },
  ],
  parameters: {
    layout: 'fullscreen',
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
  },
};

export default preview;
