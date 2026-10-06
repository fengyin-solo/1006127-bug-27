import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Shield = () => import('@/views/shield/index.vue')
const Ring = () => import('@/views/ring/index.vue')
const Segment = () => import('@/views/segment/index.vue')
const Grouting = () => import('@/views/grouting/index.vue')
const Regrout = () => import('@/views/regrout/index.vue')
const Muck = () => import('@/views/muck/index.vue')
const Settlement = () => import('@/views/settlement/index.vue')
const Axis = () => import('@/views/axis/index.vue')
const Cutter = () => import('@/views/cutter/index.vue')
const Segmentprod = () => import('@/views/segmentprod/index.vue')
const Mortar = () => import('@/views/mortar/index.vue')
const Ventilation = () => import('@/views/ventilation/index.vue')
const Building = () => import('@/views/building/index.vue')
const Utility = () => import('@/views/utility/index.vue')
const Progress = () => import('@/views/progress/index.vue')
const Testing = () => import('@/views/testing/index.vue')
const Drill = () => import('@/views/drill/index.vue')
const Crew = () => import('@/views/crew/index.vue')
const Safety = () => import('@/views/safety/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/shield', name: 'shield', component: Shield },
    { path: '/ring', name: 'ring', component: Ring },
    { path: '/segment', name: 'segment', component: Segment },
    { path: '/grouting', name: 'grouting', component: Grouting },
    { path: '/regrout', name: 'regrout', component: Regrout },
    { path: '/muck', name: 'muck', component: Muck },
    { path: '/settlement', name: 'settlement', component: Settlement },
    { path: '/axis', name: 'axis', component: Axis },
    { path: '/cutter', name: 'cutter', component: Cutter },
    { path: '/segmentprod', name: 'segmentprod', component: Segmentprod },
    { path: '/mortar', name: 'mortar', component: Mortar },
    { path: '/ventilation', name: 'ventilation', component: Ventilation },
    { path: '/building', name: 'building', component: Building },
    { path: '/utility', name: 'utility', component: Utility },
    { path: '/progress', name: 'progress', component: Progress },
    { path: '/testing', name: 'testing', component: Testing },
    { path: '/drill', name: 'drill', component: Drill },
    { path: '/crew', name: 'crew', component: Crew },
    { path: '/safety', name: 'safety', component: Safety },
  ],
})

export default router
