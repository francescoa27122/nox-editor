import type { Preview } from '@storybook/svelte-vite';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import './preview.css';

/**
 * Both themes, one switch.
 *
 * Eclipse and Umbra are token overrides of one another (DESIGN.md §2), so a
 * component that reads only tokens is correct in both for free — and one that
 * hardcoded a colour shows up the moment the toolbar is flipped. That is the
 * cheapest enforcement the token rule has ever had.
 */
const preview: Preview = {
  parameters: {
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    // Storybook's own backgrounds would paint over `--nox-bg-*` and make
    // every contrast reading optimistic. The tokens are the background.
    backgrounds: { disable: true },
    // 'error' rather than 'todo' because the set is now known to be clean:
    // all seven stories pass axe under `npm run test:stories`, measured before
    // this line moved. 'todo' only surfaced violations in the addon panel,
    // which meant a regression waited for someone to open the panel and look.
    a11y: { test: 'error' },
  },
  globalTypes: {
    theme: {
      description: 'Nox theme',
      toolbar: {
        title: 'Theme',
        icon: 'moon',
        items: [
          { value: 'eclipse', title: 'Eclipse' },
          { value: 'umbra', title: 'Umbra' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'eclipse' },
  decorators: [
    (story, context) => {
      // Written to the document rather than a wrapper element because that is
      // where `app.ts:529` writes it, and because tokens.css scopes the
      // palette at `:root`. A wrapper would leave anything rendered up at
      // <body> — menus, dialogs, toasts — painted in the other theme.
      document.documentElement.setAttribute('data-nox-theme', String(context.globals['theme']));
      return story();
    },
  ],
};

export default preview;
