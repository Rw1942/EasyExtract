export const state = {
  healthStatus: null,
  currentBucket: null,
  editingTemplateId: null,
  viewingTemplateId: null,
  navStack: ['home'],
  afterTemplateSaved: null,
  pollingBucketId: null,
  allTemplatesCache: null,
  jobsCache: null,
  selectedJobIds: new Set(),
  jobsRefreshPaused: false,
  jobsRefreshTimer: null,
  expandedJobId: null,
  jobDetailCache: {},
  templateDetailCache: {},
  pageClassificationCache: {},
};

export async function ensureTemplatesLoaded(api) {
  if (!state.allTemplatesCache) state.allTemplatesCache = await api('/templates');
  return state.allTemplatesCache;
}

export function invalidateTemplateCache() {
  state.allTemplatesCache = null;
}
