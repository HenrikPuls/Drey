/**
 * Image viewing (ADR-0026): a shared zoom/pan `ImageViewer` reused by the
 * fullscreen `ImageLightbox` and the `kind: 'image'` editor tab
 * (`ImageTab`). Thin barrel per the feature-module convention (ADR-0016).
 */
export { ImageViewer } from './image-viewer';
export { ImageLightbox } from './image-lightbox';
export { ImageLightboxService } from './image-lightbox.service';
