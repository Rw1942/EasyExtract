import { state } from './state.js';

const handlers = {
  showDashboard: null,
  showTemplateList: null,
  showTemplateBuilder: null,
  showJobs: null,
  showTemplateDetail: null,
  openBucket: null,
  openReview: null,
};

export function configureNavigation(next) {
  Object.assign(handlers, next);
}

export function showView(id) {
  if (id !== 'viewBucket') state.pollingBucketId = null;
  if (id !== 'viewJobs' && state.jobsRefreshTimer) {
    clearTimeout(state.jobsRefreshTimer);
    state.jobsRefreshTimer = null;
  }
  document.querySelectorAll('.view').forEach((v) => {
    v.hidden = true;
  });
  const view = document.getElementById(id);
  if (view) view.hidden = false;
}

export function goBack() {
  state.navStack.pop();
  const prev = state.navStack[state.navStack.length - 1] || 'home';
  if (prev === 'home') showHome();
  else if (prev === 'dashboard') handlers.showDashboard?.();
  else if (prev === 'templateList') handlers.showTemplateList?.();
  else if (prev === 'templateBuilder') handlers.showTemplateBuilder?.();
  else if (prev === 'jobs') handlers.showJobs?.();
  else if (prev.startsWith('templateDetail:')) handlers.showTemplateDetail?.(prev.split(':')[1], true);
  else if (prev.startsWith('bucket:')) handlers.openBucket?.(prev.split(':')[1], true);
  else if (prev.startsWith('review:')) handlers.openReview?.(prev.split(':')[1], true);
}

export function goHome() {
  state.navStack = ['dashboard'];
  handlers.showDashboard?.();
}

export function showHome() {
  state.navStack = ['home'];
  showView('viewHome');
  updateBreadcrumb([{ label: 'Home' }]);
}

export function goToTemplates() {
  state.navStack = ['templateList'];
  handlers.showTemplateList?.();
}

export function setActiveTab(tab) {
  document.getElementById('navHome')?.classList.toggle('active', tab === 'home');
  document.getElementById('navBuckets')?.classList.toggle('active', tab === 'buckets');
  document.getElementById('navJobs')?.classList.toggle('active', tab === 'jobs');
  document.getElementById('navTemplates')?.classList.toggle('active', tab === 'templates');
}

export function updateBreadcrumb(parts) {
  const section = parts[0]?.label;
  const isSection = section === 'Home' || section === 'Buckets' || section === 'Templates' || section === 'Jobs';
  setActiveTab(
    section === 'Home' ? 'home'
      : section === 'Buckets' ? 'buckets'
        : section === 'Jobs' ? 'jobs'
          : section === 'Templates' ? 'templates' : '',
  );

  const trail = isSection ? parts.slice(1) : parts;
  const bc = document.getElementById('breadcrumb');
  if (!bc) return;
  if (!trail.length) {
    bc.innerHTML = '';
    return;
  }

  const prefix = isSection ? '/ ' : '';
  bc.innerHTML = prefix + trail.map((p, i) => (
    i < trail.length - 1
      ? `<a onclick="${p.action}">${p.label}</a> / `
      : `<span>${p.label}</span>`
  )).join('');
}

export function initNavigation() {
  const title = document.getElementById('headerTitle');
  if (title) title.onclick = showHome;
}
