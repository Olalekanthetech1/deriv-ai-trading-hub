# ============================================================
# BASE
# ============================================================
FROM node:22-bookworm-slim AS base

# ------------------------------------------------------------
# System dependencies
# ------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-dev \
    python3-venv \
    build-essential \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# Create isolated Python virtual environment
# ------------------------------------------------------------
RUN python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# ------------------------------------------------------------
# Upgrade Python packaging tools
# ------------------------------------------------------------
RUN python -m pip install --upgrade \
    pip \
    setuptools \
    wheel

# ------------------------------------------------------------
# Install Python ML dependencies
# ------------------------------------------------------------
COPY requirements.txt ./requirements.txt

RUN python -m pip install \
    --no-cache-dir \
    -r requirements.txt


# ============================================================
# STEP 1 — NODE DEPENDENCIES
# ============================================================
FROM base AS deps

WORKDIR /app

# ------------------------------------------------------------
# Copy package manifest
# ------------------------------------------------------------
COPY package.json ./

# Workspace/package manifest
COPY packages/core/package.json ./packages/core/package.json

# ------------------------------------------------------------
# Copy scripts BEFORE npm install.
# ------------------------------------------------------------
COPY scripts ./scripts

# ------------------------------------------------------------
# Copy packages required by the project
# ------------------------------------------------------------
COPY packages ./packages

# ------------------------------------------------------------
# Install Node dependencies.
# ------------------------------------------------------------
RUN npm install --ignore-scripts

# ------------------------------------------------------------
# Security gate: production builds must not proceed while npm
# reports known high/critical dependency vulnerabilities.
# This is intentionally separate from `npm install`; it makes
# dependency security a deterministic deployment requirement.
# ------------------------------------------------------------
RUN npm audit --audit-level=high

# ------------------------------------------------------------
# Run the project's postinstall explicitly.
# ------------------------------------------------------------
RUN npm run postinstall


# ============================================================
# STEP 2 — NEXT.JS BUILDER
# ============================================================
FROM base AS builder

WORKDIR /app

# ------------------------------------------------------------
# Copy installed Node dependencies
# ------------------------------------------------------------
COPY --from=deps /app/node_modules ./node_modules

# ------------------------------------------------------------
# Copy package configuration
# ------------------------------------------------------------
COPY --from=deps /app/package.json ./package.json

# ------------------------------------------------------------
# Copy packages and scripts prepared by deps stage
# ------------------------------------------------------------
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/scripts ./scripts

# ------------------------------------------------------------
# Source revision cache-buster.
# Changing this value intentionally invalidates the source COPY
# layer so a stale Render/Docker source layer cannot survive a
# source-boundary fix.
# ------------------------------------------------------------
ARG APP_SOURCE_REV=9cb8349
RUN echo "Building application source revision: ${APP_SOURCE_REV}"

# ------------------------------------------------------------
# Copy the rest of the application
# ------------------------------------------------------------
COPY . .

# ------------------------------------------------------------
# Build-time guard: Client Components must never import the
# server-side ML evaluator/daemon or API route modules.
# This converts an opaque Next.js dependency-trace failure into
# a deterministic build failure with the offending import shown.
# ------------------------------------------------------------
RUN echo "Verifying browser-safe Multi-Model boundaries..." && \
    if grep -nE "from ['\"]@/lib/(multi-model-evaluator|xgboost-daemon|production-ensemble|onnx-engine)|from ['\"].*app/api/" \
      components/custom/signals-drawer.tsx components/custom/multi-model-evaluation-card.tsx; then \
      echo "ERROR: server-only ML dependency detected in a Client Component."; \
      exit 1; \
    fi && \
    echo "Browser-safe Multi-Model boundary check passed."

# ------------------------------------------------------------
# Render build arguments
# ------------------------------------------------------------

ARG NEXT_PUBLIC_DERIV_APP_ID
ENV NEXT_PUBLIC_DERIV_APP_ID=$NEXT_PUBLIC_DERIV_APP_ID

ARG NEXT_PUBLIC_DERIV_REDIRECT_URI
ENV NEXT_PUBLIC_DERIV_REDIRECT_URI=$NEXT_PUBLIC_DERIV_REDIRECT_URI

ARG NEXT_PUBLIC_DERIV_APP_NAME
ENV NEXT_PUBLIC_DERIV_APP_NAME=$NEXT_PUBLIC_DERIV_APP_NAME

ARG NEXT_PUBLIC_DERIV_REFERRAL_LINK
ENV NEXT_PUBLIC_DERIV_REFERRAL_LINK=$NEXT_PUBLIC_DERIV_REFERRAL_LINK

ARG NEXT_PUBLIC_DERIV_OAUTH_SCOPES
ENV NEXT_PUBLIC_DERIV_OAUTH_SCOPES=$NEXT_PUBLIC_DERIV_OAUTH_SCOPES

ARG NEXT_PUBLIC_DERIV_ENV
ENV NEXT_PUBLIC_DERIV_ENV=$NEXT_PUBLIC_DERIV_ENV

ARG NEXT_PUBLIC_FONT_FAMILY
ENV NEXT_PUBLIC_FONT_FAMILY=$NEXT_PUBLIC_FONT_FAMILY

# ------------------------------------------------------------
# Next.js production configuration
# ------------------------------------------------------------
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ------------------------------------------------------------
# Build application
# ------------------------------------------------------------
RUN npm run build


# ============================================================
# STEP 3 — PRODUCTION RUNNER
# ============================================================
FROM base AS runner

WORKDIR /app

# ------------------------------------------------------------
# Runtime environment
# ------------------------------------------------------------
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV PATH="/opt/venv/bin:$PATH"

# ------------------------------------------------------------
# Create non-root runtime user
# ------------------------------------------------------------
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

# ------------------------------------------------------------
# Next.js production output
# ------------------------------------------------------------
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next

# ------------------------------------------------------------
# Node dependencies
# ------------------------------------------------------------
COPY --from=builder /app/node_modules ./node_modules

# ------------------------------------------------------------
# Application metadata
# ------------------------------------------------------------
COPY --from=builder /app/package.json ./package.json

# ------------------------------------------------------------
# Application packages
# ------------------------------------------------------------
COPY --from=builder /app/packages ./packages

# ------------------------------------------------------------
# Scripts
# ------------------------------------------------------------
COPY --from=builder /app/scripts ./scripts

# Dedicated ML worker imports server-side library modules directly.
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# ------------------------------------------------------------
# Ensure runtime user owns application files
# ------------------------------------------------------------
RUN chown -R nextjs:nodejs /app

# ------------------------------------------------------------
# Start the production server.
# Explicit CMD is required for Docker/Render; without it the
# container builds successfully but exits immediately at runtime.
# ------------------------------------------------------------
USER nextjs
CMD ["npm", "run", "start"]
