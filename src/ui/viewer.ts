// 在容器中挂载一个 Renderer 并随尺寸自适应。
import { Renderer } from '../render/Renderer';

export interface ViewerHandle {
  renderer: Renderer;
  dispose: () => void;
}

export function mountViewer(container: HTMLElement): ViewerHandle {
  const canvas = document.createElement('canvas');
  container.append(canvas);
  const renderer = new Renderer(canvas);
  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(container);
  return {
    renderer,
    dispose: () => {
      ro.disconnect();
      renderer.dispose();
      canvas.remove();
    },
  };
}
