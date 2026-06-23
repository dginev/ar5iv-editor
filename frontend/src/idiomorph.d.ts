// Ambient type declaration for `idiomorph` — the package ships no types and
// there is no `@types/idiomorph` (as of 0.7.x). Types only the surface we use:
// `Idiomorph.morph(oldNode, newContent, options?)`. See `preview.ts`.
declare module "idiomorph" {
  export interface IdiomorphOptions {
    morphStyle?: "innerHTML" | "outerHTML";
    ignoreActive?: boolean;
    ignoreActiveValue?: boolean;
    head?: { style?: "merge" | "append" | "morph" | "none" };
    callbacks?: Record<string, (...args: unknown[]) => unknown>;
  }
  export const Idiomorph: {
    morph(oldNode: Node, newContent: Node | string, options?: IdiomorphOptions): void;
  };
}
