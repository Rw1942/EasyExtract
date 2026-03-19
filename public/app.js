import { checkHealth, toggleDebugPanel, clearDebugPanel, updateDebugCount, switchRunTab } from './js/shared.js';
import { configureNavigation, initNavigation, showHome, goHome, goToTemplates, goBack } from './js/navigation.js';
import {
  exposeBucketActions,
  initBucketDomHandlers,
  showDashboard,
  openBucket,
} from './js/buckets.js';
import {
  exposeTemplateActions,
  initTemplateDomHandlers,
  showTemplateList,
  showTemplateBuilder,
  showTemplateDetail,
} from './js/templates.js';
import { exposeJobsReviewActions, showJobs, openReview } from './js/jobsReview.js';

const bucketActions = exposeBucketActions();
const templateActions = exposeTemplateActions();
const jobsReviewActions = exposeJobsReviewActions();

configureNavigation({
  showDashboard,
  showTemplateList,
  showTemplateBuilder,
  showJobs,
  showTemplateDetail,
  openBucket,
  openReview,
});

initNavigation();
initBucketDomHandlers();
initTemplateDomHandlers();

Object.assign(window, {
  showHome,
  goHome,
  goToTemplates,
  goBack,
  toggleDebugPanel,
  clearDebugPanel,
  updateDebugCount,
  switchRunTab,
  ...bucketActions,
  ...templateActions,
  ...jobsReviewActions,
});

await checkHealth();
showHome();
