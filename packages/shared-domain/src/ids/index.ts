import { v5, v7 } from 'uuid';

export type UUID = string;

export function uuidv7(): UUID {
  return v7();
}

export function uuidv5(name: string, namespace: UUID): UUID {
  return v5(name, namespace);
}
