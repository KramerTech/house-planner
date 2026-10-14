import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideOptimus } from '@openng/optimus-ui/config';
import Aura from '@openng/optimus-ui-themes/aura';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideOptimus({ theme: { preset: Aura, options: { darkModeSelector: '.app-dark' } } }),
  ],
};
