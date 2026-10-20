/** Retain every own field, including nonenumerable data, without evaluating accessors. */
export function copyCircuitRecord<T extends object>(source: T, patch: Partial<T> = {}, omit: readonly (keyof T)[] = []): T {
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of omit) { Reflect.deleteProperty(descriptors, key); }
  return Object.defineProperties({}, { ...descriptors, ...Object.getOwnPropertyDescriptors(patch) }) as T;
}
