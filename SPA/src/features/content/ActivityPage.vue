<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import ActivityPanel from './ActivityPanel.vue';
</script>
<template><section class="social-view" data-screen="private-activity"><header class="social-view__head"><p class="eyebrow">Only you</p><h1>Your time at <em>Commonplace.</em></h1><p class="social-view__lede">Posts, reactions and comments you can still access.</p><RouterLink class="text-link" :to="{name:'my-posts',query:{status:'draft'}}">Manage drafts</RouterLink></header><ActivityPanel private-history /></section></template>
