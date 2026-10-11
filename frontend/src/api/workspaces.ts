import { apiRequest } from './httpClient';
import type { WorkspaceSummary } from './types';

export function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return apiRequest<WorkspaceSummary[]>('/workspaces');
}

export function createWorkspace(input: { name: string }): Promise<WorkspaceSummary> {
  return apiRequest<WorkspaceSummary>('/workspaces', { method: 'POST', body: input });
}
