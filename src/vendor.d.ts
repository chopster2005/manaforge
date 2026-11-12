declare module 'react' {
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export interface MutableRefObject<T> { current: T; }
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  const React: any;
  export default React;
}
declare module 'react-dom/client' { export function createRoot(node: Element | DocumentFragment): { render(node: any): void }; }
declare module 'react/jsx-runtime' { export const jsx: any; export const jsxs: any; export const Fragment: any; }
declare module 'lucide-react' {
  export const Activity: any; export const AlertCircle: any; export const ArrowDownToLine: any; export const ArrowLeftRight: any;
  export const Camera: any; export const Check: any; export const ChevronDown: any; export const CircleDollarSign: any;
  export const Database: any; export const Download: any; export const FileImage: any; export const FolderPlus: any;
  export const ImagePlus: any; export const Layers3: any; export const LoaderCircle: any; export const PackagePlus: any;
  export const Plus: any; export const RefreshCw: any; export const Search: any; export const Settings2: any;
  export const ShieldCheck: any; export const Sparkles: any; export const Square: any; export const StopCircle: any;
  export const Sun: any; export const Trash2: any; export const Upload: any; export const Video: any; export const X: any;
}
declare namespace JSX { interface IntrinsicElements { [elementName: string]: any; } }
declare module '*.css';
