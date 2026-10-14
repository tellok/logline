import { type LoglinePlugin } from '../../core/types';

/**
 * Create a click logging plugin.
 * Listen for click or touch events and log element IDs, classes, and text.
 */
export const createClickLogPlugin = (): LoglinePlugin => {
  return {
    name: 'click-log',
    install: (context) => {
      if (typeof window === 'undefined') return;

      // Use click for supported desktop platforms and touchstart otherwise.
      const isDesktop = /Win\d{2}|Windows/.test(navigator.platform) || /\(Macintosh; Intel /i.test(navigator.userAgent);
      const preferEvent = isDesktop ? 'click' : 'touchstart';

      window.addEventListener(preferEvent, (event) => {
        if (event.target instanceof Element) {
          let dom: Element | undefined = event.target;
          let findIndex = 0;
          do {
            const { classList, id, textContent } = dom;
            if (classList.length || id) {
              let text = (textContent || '').trim();
              // Mask alphanumeric text of at least ten characters containing both letters and digits.
              const isLongMixedAlphaNum = /^[a-zA-Z0-9]{10,}$/.test(text) && /[a-zA-Z]/.test(text) && /\d/.test(text);
              if (isLongMixedAlphaNum) {
                text = '*';
              }
              // Truncate long text.
              if (text.length > 10) {
                text = `${text.slice(0, 10)}...`;
              }

              context.log(
                [
                  'click ',
                  id ? `#${id}` : '',
                  classList.length ? `.${Array.from(classList).join('.')}` : '',
                  text ? ` "${text}"` : '',
                ]
                  .filter(Boolean)
                  .join(''),
              );
              break;
            }
            if (findIndex++ > 20) {
              dom = undefined;
              break;
            }
          } while ((dom = dom.parentElement ?? undefined));

          if (!dom) {
            context.log('click');
          }
        }
      });
    },
  };
};
