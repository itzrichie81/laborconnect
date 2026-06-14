/* global window, document, localStorage, navigator, sessionStorage */

// Global dark mode management - persists across all pages
(function() {
  const DARK_MODE_KEY = 'laborconnect-dark-mode';
  
  function initDarkMode() {
    const isDarkActive = localStorage.getItem(DARK_MODE_KEY) === 'true';
    if (isDarkActive) {
      document.body.classList.add('dark-active');
      updateDarkToggle();
    }
  }
  
  window.switchDarkMode = function() {
    const isDark = document.body.classList.toggle('dark-active');
    localStorage.setItem(DARK_MODE_KEY, isDark);
    updateDarkToggle();
  };
  
  function updateDarkToggle() {
    const toggle = document.querySelector('.dark-toggle-btn i');
    if (toggle) {
      if (document.body.classList.contains('dark-active')) {
        toggle.classList.remove('fa-moon');
        toggle.classList.add('fa-sun');
      } else {
        toggle.classList.remove('fa-sun');
        toggle.classList.add('fa-moon');
      }
    }
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDarkMode);
  } else {
    initDarkMode();
  }
})();

// ==================== GLOBAL API AND SOCKET URL DEFINITIONS ====================
// HARDCODED FOR VERCELL DEPLOYMENT - Backend on Render
const API_URL = 'https://laborconnect-api.onrender.com/api';
const SOCKET_URL = 'https://laborconnect-api.onrender.com';

if (typeof API_URL !== 'undefined') {
    window.API_URL = API_URL;
}
if (typeof SOCKET_URL !== 'undefined') {
    window.SOCKET_URL = SOCKET_URL;
}


if (typeof window.__COMMON_CALLS_LOADED__ === 'undefined') {
window.__COMMON_CALLS_LOADED__ = true;

let globalSocket = null;
let currentUser = null;
let globalIncomingModal = null;
let globalPendingCall = null;
let ringTimeout = null;
let activePeerConnection = null;
let activeLocalStream = null;
let callStartTime = null;
let callTimerInterval = null;
let isInCall = false;
let currentCallId = null;
let currentChatId = null;
let currentCallType = null;
let currentOtherUserId = null;
let isFrontCamera = true;
let isMinimized = false;
let isCallPeekMode = false;
let callBannerDragState = null;
let callInteractionHandlersAttached = false;
let callShellState = null;
let controlsTimeout = null;
let isCreatingCallUI = false;
const CALL_STATE_KEY = 'laborconnect-call-state';
let currentCallPeerName = null;
let currentCallPeerPhoto = null;
let currentCallPeerId = null;
let currentCallLocalProfileName = null;
let currentCallLocalProfilePhoto = null;

// ===== CONNECTION STATUS MONITORING =====
let isOnline = navigator.onLine;
window.addEventListener('online', () => {
    isOnline = true;
    console.log('🌐 Connection restored');
    if (globalSocket && globalSocket.disconnected) {
        globalSocket.connect();
    }
});
window.addEventListener('offline', () => {
    isOnline = false;
    console.log('⚠️ Connection lost');
    const statusDiv = document.getElementById('connectionStatus');
    if (statusDiv) {
        statusDiv.className = 'connection-status disconnected';
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No internet connection';
        statusDiv.style.display = 'flex';
    }
});

// Audio beep for ringtone
let audioContext = null;
let ringInterval = null;

function playBeep(frequency, duration) {
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.frequency.value = frequency;
        gain.gain.value = 0.2;
        oscillator.start();
        gain.gain.exponentialRampToValueAtTime(0.00001, audioContext.currentTime + duration);
        oscillator.stop(audioContext.currentTime + duration);
    } catch(e) {
        console.log('Beep failed:', e);
    }
}

function playRingtone() {
    function ring() {
        playBeep(800, 0.4);
        setTimeout(() => {
            playBeep(800, 0.4);
            setTimeout(() => {
                playBeep(600, 0.3);
            }, 300);
        }, 300);
    }
    ring();
    if (ringInterval) clearInterval(ringInterval);
    ringInterval = setInterval(ring, 2000);
}

function stopRingtone() {
    if (ringInterval) {
        clearInterval(ringInterval);
        ringInterval = null;
    }
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getDisplayName(user, fallback = 'Unknown User') {
  if (!user) return fallback;
  if (user.name) return user.name;
  if (user.fullName) return user.fullName;
  const first = user.firstName || '';
  const last = user.lastName || '';
  const combined = `${first} ${last}`.trim();
  return combined || fallback;
}

function getProfilePhoto(user) {
  return user?.photoURL || user?.photourl || user?.avatar || user?.profilePhoto || '';
}

function createAvatarMarkup(user, fallbackName, size = 54) {
  const displayName = getDisplayName(user, fallbackName);
  const photo = getProfilePhoto(user);
  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || '')
    .join('') || 'U';
  const sizePx = `${size}px`;
  if (photo) {
    return `<img src="${photo}" alt="${displayName}" style="width:${sizePx};height:${sizePx};border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,0.95);">`;
  }
  return `<div style="width:${sizePx};height:${sizePx};border-radius:50%;display:flex;align-items:center;justify-content:center;background:#2563eb;color:white;font-weight:700;font-size:${Math.max(14, Math.round(size / 2.4))}px;border:2px solid rgba(255,255,255,0.95);">${initials}</div>`;
}

function renderIdentityOverlay(overlayEl, user, fallbackName, subtitle, size = 72, compact = false) {
  if (!overlayEl) return;
  const displayName = getDisplayName(user, fallbackName);
  const cardStyle = compact ? 'padding:8px 10px; gap:8px; border-radius:12px;' : 'padding:16px 20px; gap:12px; border-radius:18px;';
  overlayEl.innerHTML = `
    <div style="display:flex;align-items:center;flex-direction:column;text-align:center;color:white;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,0.25);${cardStyle}">
      <div>${createAvatarMarkup(user, fallbackName, size)}</div>
      <div style="display:flex;flex-direction:column;gap:2px;">
        <div style="font-weight:700;font-size:${compact ? '11px' : '16px'};">${displayName}</div>
        <div style="font-size:${compact ? '9px' : '12px'};opacity:0.85;">${subtitle}</div>
      </div>
    </div>
  `;
  overlayEl.style.display = 'flex';
}

function getPersistedCallState() {
  try {
    const raw = sessionStorage.getItem(CALL_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn('Call state restore failed:', err);
    return {};
  }
}

function persistCallState(patch = {}) {
  const nextState = { ...getPersistedCallState(), ...patch };
  callShellState = nextState;
  sessionStorage.setItem(CALL_STATE_KEY, JSON.stringify(nextState));
  return nextState;
}

function clearPersistedCallState() {
  callShellState = null;
  sessionStorage.removeItem(CALL_STATE_KEY);
}

function setCallIdentityOverlayVisibility(visible) {
  const remoteOverlay = document.getElementById('remoteIdentityOverlay');
  const localOverlay = document.getElementById('localIdentityOverlay');
  if (remoteOverlay) remoteOverlay.style.display = visible ? 'flex' : 'none';
  if (localOverlay) localOverlay.style.display = visible ? 'flex' : 'none';
}

function setLocalVideoEnabled(enabled) {
  if (!activeLocalStream) return;
  activeLocalStream.getVideoTracks().forEach(track => {
    track.enabled = enabled;
  });
}

function attachCallInteractionHandlers() {
  if (callInteractionHandlersAttached) return;
  const handleCallInteraction = (event) => {
    if (!isInCall || currentCallType !== 'video' || !isCallPeekMode) return;
    const target = event.target;
    if (target && target.closest && target.closest('#topCallBanner')) return;
    if (target && target.closest && target.closest('#globalIncomingCallModal')) return;
    if (event.type === 'click' || event.type === 'touchstart') {
      showCallMedia();
    }
  };
  document.addEventListener('click', handleCallInteraction, true);
  document.addEventListener('touchstart', handleCallInteraction, true);
  callInteractionHandlersAttached = true;
}

function enterCallPeekMode() {
  if (currentCallType !== 'video') return;
  isCallPeekMode = true;
  persistCallState({ minimized: true, videoPaused: true, shouldShowCallScreen: false });
  const container = document.getElementById('callMediaContainer');
  if (container) {
    container.style.display = 'none';
    container.classList.add('minimized');
    isMinimized = true;
  }
  setLocalVideoEnabled(false);
  setCallIdentityOverlayVisibility(false);
  attachCallInteractionHandlers();
}

function restoreCallSurface() {
  const state = getPersistedCallState();
  if (!state || !state.status || state.status === 'idle') return;
  if (state.status === 'connected' && state.callType === 'video' && state.shouldShowCallScreen) {
    showCallMedia();
  }
  if (state.status === 'connected' && state.callType === 'video' && state.videoPaused) {
    setLocalVideoEnabled(false);
  }
  if (state.status === 'ringing' || state.status === 'connected') {
    showCallBanner(state.status === 'connected' ? 'Connected' : 'Ringing...');
  }
}

function navigateToCallPage() {
  const targetUserId = currentOtherUserId || getPersistedCallState().remoteUserId;
  if (!targetUserId) return;
  persistCallState({ shouldShowCallScreen: true, minimized: false, videoPaused: false });
  const targetPath = `chat.html?with=${targetUserId}`;
  if (window.location.pathname.endsWith('/chat.html') || window.location.pathname.endsWith('chat.html')) {
    if (window.location.search.includes(`with=${targetUserId}`)) {
      if (document.getElementById('callMediaContainer')) {
        showCallMedia();
      }
      return;
    }
  }
  window.location.href = targetPath;
}

async function loadUserProfile(userId) {
  if (!userId) return null;
  try {
    const response = await fetch(`${API_URL}/user/${userId}`);
    if (!response.ok) return null;
    const user = await response.json();
    return user || null;
  } catch (err) {
    console.warn('Could not load user profile:', err);
    return null;
  }
}

function getUserPhoto(user) {
  return user?.photourl || user?.photoURL || user?.photo || null;
}

function getUserDisplayName(user, fallback = 'User') {
  if (user?.name) return user.name;
  if (user?.firstName || user?.lastName) {
    return `${user.firstName || ''} ${user.lastName || ''}`.trim();
  }
  return fallback;
}

function buildProfileAvatarMarkup(name, photo, fallbackText, size = 52) {
  const safeName = (name || fallbackText || 'U').toString();
  const initials = safeName.split(' ').filter(Boolean).slice(0, 2).map(n => n[0]).join('').substring(0, 2).toUpperCase() || 'U';
  if (photo && photo !== 'null' && photo !== 'undefined') {
    return `<img src="${photo}" alt="${safeName}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,0.9);">`;
  }
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#0ea5e9);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:${Math.max(14, size / 3)}px;border:2px solid rgba(255,255,255,0.9);">${initials}</div>`;
}

function updateCallProfileOverlay() {
  const remoteOverlay = document.getElementById('remoteIdentityOverlay');
  const localOverlay = document.getElementById('localIdentityOverlay');
  const remoteName = currentCallPeerName || (currentOtherUserId ? `User ${currentOtherUserId}` : 'Connecting...');
  const remotePhoto = currentCallPeerPhoto;
  const localName = currentCallLocalProfileName || getUserDisplayName(currentUser, 'You');
  const localPhoto = currentCallLocalProfilePhoto || getUserPhoto(currentUser);
  if (currentCallType === 'video' && isInCall) {
    setCallIdentityOverlayVisibility(false);
    return;
  }

  if (remoteOverlay) {
    renderIdentityOverlay(remoteOverlay, { name: remoteName, photoURL: remotePhoto }, remoteName, currentCallType === 'video' ? 'Video call' : currentCallType === 'audio' ? 'Audio call' : 'Connecting...', 72, false);
  }

  if (localOverlay) {
    renderIdentityOverlay(localOverlay, { name: localName, photoURL: localPhoto }, 'You', 'Preview', 46, true);
  }
}

function syncCallOverlayPosition() {
  const localVideoWrapper = document.getElementById('localVideoWrapper');
  if (!localVideoWrapper) return;
  if (!localVideoWrapper.style.bottom && !localVideoWrapper.style.top && !localVideoWrapper.style.left && !localVideoWrapper.style.right) {
    localVideoWrapper.style.bottom = '20px';
    localVideoWrapper.style.right = '20px';
    localVideoWrapper.style.width = '120px';
    localVideoWrapper.style.height = '160px';
    localVideoWrapper.style.borderRadius = '12px';
  }
}

async function loadCallPeerProfile(userId) {
  if (!userId) return;
  try {
    const res = await fetch(`${API_URL}/user/${userId}`);
    const user = await res.json();
    if (user) {
      currentCallPeerName = getUserDisplayName(user, `User ${userId}`);
      currentCallPeerPhoto = getUserPhoto(user);
      currentCallPeerId = userId;
      updateCallProfileOverlay();
    }
  } catch (err) {
    console.warn('Failed to load call peer profile:', err);
  }
}

// ========== CALL CONTROLS ==========
function showCallControls() {
  const controlsContainer = document.getElementById('callControlsContainer');
  if (controlsContainer) {
    controlsContainer.style.opacity = '1';
    controlsContainer.style.visibility = 'visible';
  }
  if (controlsTimeout) clearTimeout(controlsTimeout);
  controlsTimeout = setTimeout(() => {
    hideCallControls();
  }, 3000);
}

function hideCallControls() {
  const controlsContainer = document.getElementById('callControlsContainer');
  if (controlsContainer && !isMinimized) {
    controlsContainer.style.opacity = '0';
    controlsContainer.style.visibility = 'hidden';
  }
}

// ========== FULLSCREEN VIDEO CALL UI - REAL FIX (NO DUPLICATES) ==========
// Track if call UI is currently being destroyed
let isDestroyingCallUI = false;

function destroyCallUI() {
  if (isDestroyingCallUI) return;
  isDestroyingCallUI = true;
  
  const container = document.getElementById('callMediaContainer');
  if (container) {
    container.remove();
  }
  
  // Also clean up any stray video elements
  const strayElements = ['localVideo', 'remoteVideo', 'localVideoWrapper'];
  strayElements.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  
  isDestroyingCallUI = false;
}

function createCallMediaElements() {
  // REAL FIX: Destroy any existing UI first - this prevents duplicates
  destroyCallUI();
  
  // Set flag to prevent multiple simultaneous creations
  if (isCreatingCallUI) {
    console.log('Already creating call UI, waiting...');
    return null;
  }
  
  isCreatingCallUI = true;
  
  console.log('Creating new call media container');
  const container = document.createElement('div');
  container.id = 'callMediaContainer';
  container.className = 'call-media';
  
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    height: 100%;
    z-index: 99999;
    background: #000;
    display: flex;
    visibility: visible;
    opacity: 1;
  `;
  
  container.innerHTML = `
    <div style="position: relative; width: 100%; height: 100%; background: #000;">
      <video id="remoteVideo" autoplay playsinline style="width: 100%; height: 100%; object-fit: contain; background: #000;"></video>
      <div id="remoteIdentityOverlay" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 10006; pointer-events: none;"></div>
      
      <div id="localVideoWrapper" style="position: absolute; bottom: 20px; right: 20px; width: 140px; height: 180px; background: #333; border-radius: 12px; border: 2px solid white; overflow: hidden; cursor: grab; z-index: 10007; box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
        <video id="localVideo" autoplay muted playsinline style="width: 100%; height: 100%; background: #333; object-fit: cover;"></video>
        <div style="position: absolute; bottom: 8px; left: 0; right: 0; text-align: center; background: rgba(0,0,0,0.6); color: white; font-size: 10px; padding: 3px; margin: 0 8px; border-radius: 4px;">You</div>
      </div>
      
      <div style="position: absolute; top: 20px; left: 20px; background: rgba(0,0,0,0.6); color: white; padding: 8px 16px; border-radius: 20px; font-size: 14px; z-index: 10007;" id="callTypeBadge"></div>
      
      <div id="callControlsContainer" style="position: absolute; bottom: 30px; left: 0; right: 0; display: flex; justify-content: center; z-index: 10007; transition: opacity 0.3s ease, visibility 0.3s ease;">
        <div style="display: flex; gap: 20px; background: rgba(0, 0, 0, 0.7); padding: 12px 24px; border-radius: 60px; backdrop-filter: blur(10px);">
          <button id="toggleCameraBtn" class="call-control-btn" title="Switch camera" style="background: rgba(0,0,0,0.8); border: none; color: white; width: 50px; height: 50px; border-radius: 50%; cursor: pointer; font-size: 20px;"><i class="fas fa-sync-alt"></i></button>
          <button id="endCallFullBtn" class="call-control-btn call-end-btn" title="End call" style="background: #dc3545; border: none; color: white; width: 60px; height: 60px; border-radius: 50%; cursor: pointer; font-size: 24px;"><i class="fas fa-phone-slash"></i></button>
          <button id="minimizeCallBtn" class="call-control-btn" title="Minimize" style="background: rgba(0,0,0,0.8); border: none; color: white; width: 50px; height: 50px; border-radius: 50%; cursor: pointer; font-size: 20px;"><i class="fas fa-window-minimize"></i></button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(container);
  
  // Tap anywhere to show controls
  const showControlsHandler = (e) => {
    if (e.target.closest('.call-control-btn')) return;
    showCallControls();
  };
  
  container.addEventListener('click', showControlsHandler);
  container.addEventListener('touchstart', showControlsHandler);
  
  // Make local video draggable
  const localVideoWrapper = document.getElementById('localVideoWrapper');
  if (localVideoWrapper) {
    let isDraggingLocal = false;
    let dragStartX = 0, dragStartY = 0;
    
    const onMouseMove = (e) => {
      if (!isDraggingLocal) return;
      e.preventDefault();
      let newLeft = e.clientX - dragStartX;
      let newTop = e.clientY - dragStartY;
      const rect = localVideoWrapper.getBoundingClientRect();
      newLeft = Math.max(10, Math.min(window.innerWidth - rect.width - 10, newLeft));
      newTop = Math.max(10, Math.min(window.innerHeight - rect.height - 10, newTop));
      localVideoWrapper.style.left = newLeft + 'px';
      localVideoWrapper.style.top = newTop + 'px';
      localVideoWrapper.style.bottom = 'auto';
      localVideoWrapper.style.right = 'auto';
    };
    
    const onMouseUp = () => {
      isDraggingLocal = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (localVideoWrapper) localVideoWrapper.style.cursor = 'grab';
    };
    
    localVideoWrapper.addEventListener('mousedown', (e) => {
      if (e.target.closest('.call-control-btn')) return;
      e.preventDefault();
      isDraggingLocal = true;
      const rect = localVideoWrapper.getBoundingClientRect();
      dragStartX = e.clientX - rect.left;
      dragStartY = e.clientY - rect.top;
      localVideoWrapper.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
    
    // Touch events for mobile
    localVideoWrapper.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      const rect = localVideoWrapper.getBoundingClientRect();
      dragStartX = touch.clientX - rect.left;
      dragStartY = touch.clientY - rect.top;
      isDraggingLocal = true;
    });
    
    localVideoWrapper.addEventListener('touchmove', (e) => {
      if (!isDraggingLocal) return;
      e.preventDefault();
      const touch = e.touches[0];
      let newLeft = touch.clientX - dragStartX;
      let newTop = touch.clientY - dragStartY;
      const rect = localVideoWrapper.getBoundingClientRect();
      newLeft = Math.max(10, Math.min(window.innerWidth - rect.width - 10, newLeft));
      newTop = Math.max(10, Math.min(window.innerHeight - rect.height - 10, newTop));
      localVideoWrapper.style.left = newLeft + 'px';
      localVideoWrapper.style.top = newTop + 'px';
      localVideoWrapper.style.bottom = 'auto';
      localVideoWrapper.style.right = 'auto';
    });
    
    localVideoWrapper.addEventListener('touchend', () => {
      isDraggingLocal = false;
    });
  }
  
  // Button handlers
  const endCallBtn = document.getElementById('endCallFullBtn');
  if (endCallBtn) {
    endCallBtn.onclick = (e) => {
      e.stopPropagation();
      endGlobalCall();
    };
  }
  
  const minimizeBtn = document.getElementById('minimizeCallBtn');
  if (minimizeBtn) {
    minimizeBtn.onclick = (e) => {
      e.stopPropagation();
      minimizeCallWindow();
    };
  }
  
  const toggleCameraBtn = document.getElementById('toggleCameraBtn');
  if (toggleCameraBtn) {
    toggleCameraBtn.onclick = (e) => {
      e.stopPropagation();
      toggleCamera();
    };
  }
  
  updateCallProfileOverlay();
  showCallControls();
  
  // Reset flag after creation
  setTimeout(() => {
    isCreatingCallUI = false;
  }, 500);
  
  return {
    container,
    remoteVideo: document.getElementById('remoteVideo'),
    localVideo: document.getElementById('localVideo'),
    localVideoWrapper,
    remoteIdentityOverlay: document.getElementById('remoteIdentityOverlay'),
    localIdentityOverlay: document.getElementById('localIdentityOverlay'),
    badge: document.getElementById('callTypeBadge')
  };
}

function minimizeCallWindow() {
  const container = document.getElementById('callMediaContainer');
  if (!container) return;
  
  if (!isMinimized) {
    container.style.position = 'fixed';
    container.style.top = 'auto';
    container.style.bottom = '80px';
    container.style.right = '16px';
    container.style.left = 'auto';
    container.style.width = '240px';
    container.style.height = '320px';
    container.style.borderRadius = '16px';
    container.style.overflow = 'hidden';
    container.style.cursor = 'pointer';
    
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideoWrapper = document.getElementById('localVideoWrapper');
    
    if (remoteVideo) remoteVideo.style.objectFit = 'cover';
    if (localVideoWrapper) {
      localVideoWrapper.style.width = '60px';
      localVideoWrapper.style.height = '80px';
      localVideoWrapper.style.bottom = '10px';
      localVideoWrapper.style.right = '10px';
      localVideoWrapper.style.position = 'absolute';
    }
    
    isMinimized = true;
    
    container.onclick = (e) => {
      if (e.target.closest('.call-control-btn')) return;
      restoreCallWindow();
    };
  }
  
  hideCallControls();
}

function restoreCallWindow() {
  const container = document.getElementById('callMediaContainer');
  if (!container) return;
  
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.right = '0';
  container.style.bottom = '0';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.borderRadius = '0';
  container.style.cursor = 'default';
  
  const remoteVideo = document.getElementById('remoteVideo');
  const localVideoWrapper = document.getElementById('localVideoWrapper');
  
  if (remoteVideo) remoteVideo.style.objectFit = 'contain';
  if (localVideoWrapper) {
    localVideoWrapper.style.width = '140px';
    localVideoWrapper.style.height = '180px';
    localVideoWrapper.style.bottom = '20px';
    localVideoWrapper.style.right = '20px';
    localVideoWrapper.style.position = 'absolute';
  }
  
  isMinimized = false;
  container.onclick = null;
  showCallControls();
}

function toggleCamera() {
  if (!activeLocalStream) return;
  const videoTrack = activeLocalStream.getVideoTracks()[0];
  if (!videoTrack) {
    console.warn('No video track available');
    return;
  }
  
  videoTrack.stop();
  activeLocalStream.removeTrack(videoTrack);
  
  const nextFacingMode = isFrontCamera ? 'environment' : 'user';
  
  navigator.mediaDevices.getUserMedia({ 
    video: { facingMode: nextFacingMode }
  })
    .then(stream => {
      const newVideoTrack = stream.getVideoTracks()[0];
      if (!newVideoTrack) throw new Error('No video track');
      
      activeLocalStream.addTrack(newVideoTrack);
      const localVideo = document.getElementById('localVideo');
      if (localVideo) localVideo.srcObject = activeLocalStream;
      
      if (activePeerConnection) {
        const sender = activePeerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(newVideoTrack).catch(e => console.warn('Replace failed:', e));
      }
      
      isFrontCamera = !isFrontCamera;
    })
    .catch(err => {
      console.error('Camera switch failed:', err);
      navigator.mediaDevices.getUserMedia({ video: true })
        .then(fallbackStream => {
          const fallbackTrack = fallbackStream.getVideoTracks()[0];
          if (fallbackTrack) {
            activeLocalStream.addTrack(fallbackTrack);
            const localVideo = document.getElementById('localVideo');
            if (localVideo) localVideo.srcObject = activeLocalStream;
            if (activePeerConnection) {
              const sender = activePeerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
              if (sender) sender.replaceTrack(fallbackTrack);
            }
          }
        })
        .catch(fallbackErr => console.error('Fallback failed:', fallbackErr));
    });
}

function toggleLocalVideoPosition() {
  const localVideoWrapper = document.getElementById('localVideoWrapper');
  if (!localVideoWrapper) return;
  const currentBottom = localVideoWrapper.style.bottom;
  if (currentBottom === '20px' || !currentBottom) {
    localVideoWrapper.style.bottom = 'auto';
    localVideoWrapper.style.top = '20px';
    localVideoWrapper.style.left = '20px';
    localVideoWrapper.style.right = 'auto';
  } else {
    localVideoWrapper.style.bottom = '20px';
    localVideoWrapper.style.top = 'auto';
    localVideoWrapper.style.left = 'auto';
    localVideoWrapper.style.right = '20px';
  }
}

function hideCallMedia() {
  const container = document.getElementById('callMediaContainer');
  if (container) container.style.display = 'none';
  isMinimized = false;
  persistCallState({ shouldShowCallScreen: false, minimized: true });
}

function showCallMedia() {
  const container = document.getElementById('callMediaContainer');
  if (container) {
    container.style.display = 'flex';
    container.classList.remove('minimized');
    isMinimized = false;
    isCallPeekMode = false;
    persistCallState({ shouldShowCallScreen: true, minimized: false, videoPaused: false });
    setLocalVideoEnabled(true);
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideoWrapper = document.getElementById('localVideoWrapper');
    if (remoteVideo) remoteVideo.style.objectFit = 'contain';
    if (localVideoWrapper) {
      localVideoWrapper.style.bottom = '20px';
      localVideoWrapper.style.right = '20px';
      localVideoWrapper.style.width = '140px';
      localVideoWrapper.style.height = '180px';
      localVideoWrapper.style.borderRadius = '12px';
    }
    showCallControls();
  }
}

// ========== CALL BANNER ==========
function getCallBannerSafeBounds(width = 320, height = 72) {
  const viewportWidth = window.innerWidth || 375;
  const viewportHeight = window.innerHeight || 700;
  const menuToggle = document.querySelector('.menu-toggle, .navbar-toggle, .nav-toggle, .hamburger, #menu-toggle, #mobile-menu-toggle, .toggle-btn, .nav-trigger, .menu-button, [aria-label*="menu" i]');
  let safeRight = viewportWidth - width - 16;
  if (menuToggle) {
    const rect = menuToggle.getBoundingClientRect();
    safeRight = Math.min(safeRight, Math.max(16, rect.left - width - 12));
  }
  return {
    minX: 12,
    maxX: Math.max(12, safeRight),
    minY: 12,
    maxY: Math.max(12, viewportHeight - height - 12)
  };
}

function clampCallBannerPosition(x, y, width = 320, height = 72) {
  const { minX, maxX, minY, maxY } = getCallBannerSafeBounds(width, height);
  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y))
  };
}

function setCallBannerPosition(x, y, persist = true) {
  const banner = document.getElementById('topCallBanner');
  if (!banner) return;
  const clamped = clampCallBannerPosition(x, y, 320, 72);
  banner.style.left = `${clamped.x}px`;
  banner.style.top = `${clamped.y}px`;
  banner.style.right = 'auto';
  if (persist) {
    persistCallState({ bannerPosition: { x: clamped.x, y: clamped.y } });
  }
}

function createCallBannerBubble() {
  let bubble = document.getElementById('callBannerBubble');
  if (bubble) return bubble;
  bubble = document.createElement('button');
  bubble.id = 'callBannerBubble';
  bubble.type = 'button';
  bubble.title = 'Restore call banner';
  bubble.innerHTML = '<i class="fas fa-phone-alt"></i>';
  bubble.addEventListener('click', () => {
    persistCallState({ bannerMinimized: false });
    showCallBanner(getPersistedCallState().status === 'connected' ? 'Connected' : 'Ringing...');
  });
  document.body.appendChild(bubble);
  return bubble;
}

function createTopCallBanner() {
  let banner = document.getElementById('topCallBanner');
  if (banner) {
    createCallBannerBubble();
    return banner;
  }
  
  banner = document.createElement('div');
  banner.id = 'topCallBanner';
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
      <i class="fas fa-phone-alt" style="font-size: 15px;"></i>
      <div style="display:flex;flex-direction:column;min-width:0;">
        <span id="callStatusText" style="font-weight:700;white-space:nowrap;">Call in progress...</span>
        <span id="callTimerText" style="font-family:monospace;font-size:13px;opacity:0.9;">0:00</span>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
      <button id="minimizeCallBannerBtn" class="call-banner-btn" type="button" title="Minimize call bar"><i class="fas fa-window-minimize"></i></button>
      <button id="endCallTopBtn" class="call-banner-btn call-banner-end-btn" type="button"><i class="fas fa-phone-slash"></i> End</button>
    </div>
  `;
  document.body.appendChild(banner);
  createCallBannerBubble();

  banner.addEventListener('click', (event) => {
    if (event.target.closest('#endCallTopBtn') || event.target.closest('#minimizeCallBannerBtn')) return;
    const state = getPersistedCallState();
    if (state.status === 'connected') {
      navigateToCallPage();
    }
  });
  banner.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const rect = banner.getBoundingClientRect();
    callBannerDragState = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top
    };
    banner.setPointerCapture(event.pointerId);
  });
  banner.addEventListener('pointermove', (event) => {
    if (!callBannerDragState) return;
    const deltaX = event.clientX - callBannerDragState.startX;
    const deltaY = event.clientY - callBannerDragState.startY;
    const next = clampCallBannerPosition(callBannerDragState.startLeft + deltaX, callBannerDragState.startTop + deltaY, 320, 72);
    banner.style.left = `${next.x}px`;
    banner.style.top = `${next.y}px`;
    banner.style.right = 'auto';
    banner.style.opacity = '0.94';
  });
  banner.addEventListener('pointerup', () => {
    if (!callBannerDragState) return;
    const left = parseFloat(banner.style.left || '16');
    const top = parseFloat(banner.style.top || '76');
    setCallBannerPosition(left, top, true);
    banner.style.opacity = '1';
    callBannerDragState = null;
  });
  banner.addEventListener('pointercancel', () => {
    banner.style.opacity = '1';
    callBannerDragState = null;
  });
  document.getElementById('endCallTopBtn').onclick = () => { endGlobalCall(); };
  document.getElementById('minimizeCallBannerBtn').onclick = (event) => {
    event.stopPropagation();
    toggleCallBannerMinimized();
  };
  return banner;
}

function showCallBanner(statusText) {
  const banner = createTopCallBanner();
  const statusSpan = document.getElementById('callStatusText');
  if (statusSpan && statusText) statusSpan.textContent = statusText;
  const state = getPersistedCallState();
  if (state.bannerMinimized === true) {
    syncCallBannerVisibility();
    return;
  }
  banner.style.display = 'flex';
  banner.style.transform = 'translate(0, 0)';
  banner.style.opacity = '1';
  const position = clampCallBannerPosition(state.bannerPosition?.x ?? 16, state.bannerPosition?.y ?? 76, 320, 72);
  banner.style.left = `${position.x}px`;
  banner.style.top = `${position.y}px`;
  banner.style.right = 'auto';
  if (callTimerInterval) clearInterval(callTimerInterval);
  persistCallState({ status: statusText === 'Connected' ? 'connected' : 'ringing' });
  if (callStartTime) {
    callTimerInterval = setInterval(() => {
      if (callStartTime) {
        const duration = Math.floor((Date.now() - callStartTime) / 1000);
        const timerSpan = document.getElementById('callTimerText');
        if (timerSpan) timerSpan.textContent = formatDuration(duration);
      }
    }, 1000);
  }
  syncCallBannerVisibility();
}

function hideCallBanner() {
  const banner = document.getElementById('topCallBanner');
  const bubble = document.getElementById('callBannerBubble');
  if (banner) {
    banner.style.display = 'none';
    banner.style.transform = 'translate(0, 0)';
    banner.style.opacity = '1';
  }
  if (bubble) {
    bubble.style.display = 'none';
    bubble.style.opacity = '0';
    bubble.style.visibility = 'hidden';
  }
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
}

function toggleCallBannerMinimized() {
  const state = getPersistedCallState();
  const nextValue = state.bannerMinimized !== true;
  persistCallState({ bannerMinimized: nextValue });
  showCallBanner(state.status === 'connected' ? 'Connected' : 'Ringing...');
}

function syncCallBannerVisibility() {
  const banner = document.getElementById('topCallBanner');
  const bubble = document.getElementById('callBannerBubble');
  if (!banner || !bubble) return;
  const state = getPersistedCallState();
  const minimized = state.bannerMinimized === true;
  if (minimized) {
    banner.style.display = 'none';
    bubble.style.display = 'flex';
    bubble.style.opacity = '1';
    bubble.style.visibility = 'visible';
  } else {
    bubble.style.display = 'none';
    banner.style.display = 'flex';
    banner.style.opacity = '1';
    banner.style.transform = 'translate(0, 0)';
  }
}

function updateCallBannerStatus(statusText) {
  const statusSpan = document.getElementById('callStatusText');
  if (statusSpan) statusSpan.textContent = statusText;
}

// ========== INCOMING CALL MODAL ==========
function createIncomingCallModal() {
  if (document.getElementById('globalIncomingCallModal')) return;
  
  const modal = document.createElement('div');
  modal.id = 'globalIncomingCallModal';
  modal.style.cssText = `
    position: fixed;
    top: 60px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.95);
    backdrop-filter: blur(10px);
    border-radius: 20px;
    padding: 15px 25px;
    text-align: center;
    z-index: 10002;
    display: none;
    align-items: center;
    gap: 20px;
    min-width: 300px;
    border: 1px solid rgba(255,255,255,0.2);
    animation: slideDown 0.3s ease;
  `;
  modal.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px;">
      <div id="globalCallerAvatar" style="width: 48px; height: 48px; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #2563eb;"></div>
      <div style="text-align: left;">
        <div style="color: white; font-weight: bold;" id="globalCallerName">Someone is calling...</div>
        <div style="color: #ccc; font-size: 12px;">Incoming call</div>
      </div>
    </div>
    <div style="display: flex; gap: 15px;">
      <button id="globalAcceptCallBtn" style="background: #28a745; border: none; color: white; width: 45px; height: 45px; border-radius: 50%; cursor: pointer; font-size: 18px;">
        <i class="fas fa-check"></i>
      </button>
      <button id="globalDeclineCallBtn" style="background: #dc3545; border: none; color: white; width: 45px; height: 45px; border-radius: 50%; cursor: pointer; font-size: 18px;">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `;
  document.body.appendChild(modal);
  
  if (!document.querySelector('#globalCallStyles')) {
    const style = document.createElement('style');
    style.id = 'globalCallStyles';
    style.textContent = `@keyframes slideDown { from { opacity: 0; transform: translateX(-50%) translateY(-50px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`;
    document.head.appendChild(style);
  }
  
  globalIncomingModal = document.getElementById('globalIncomingCallModal');
  document.getElementById('globalAcceptCallBtn').onclick = () => acceptGlobalCall();
  document.getElementById('globalDeclineCallBtn').onclick = () => declineGlobalCall();
}

async function showIncomingCallModal(callerName, callerId, callType, callId, chatId, sdp) {
  createIncomingCallModal();
  const callerUser = await loadUserProfile(callerId);
  const resolvedName = callerUser?.name || callerName || `User ${callerId}`;
  globalPendingCall = { from: callerId, callType, callId, chatId, sdp, callerName: resolvedName, callerPhoto: callerUser?.photoURL || callerUser?.photourl || null };
  const callerNameEl = document.getElementById('globalCallerName');
  const callerAvatarEl = document.getElementById('globalCallerAvatar');
  if (callerNameEl) callerNameEl.innerHTML = `${resolvedName} is calling...`;
  if (callerAvatarEl) {
    callerAvatarEl.innerHTML = buildProfileAvatarMarkup(resolvedName, globalPendingCall.callerPhoto, 'User', 46);
    callerAvatarEl.style.width = '46px';
    callerAvatarEl.style.height = '46px';
  }
  if (globalIncomingModal) globalIncomingModal.style.display = 'flex';
  playRingtone();
  if (ringTimeout) clearTimeout(ringTimeout);
  ringTimeout = setTimeout(() => {
    if (globalPendingCall) {
      console.log('📞 Call auto-declined after 50 seconds');
      declineGlobalCall();
    }
  }, 50000);
}

function hideIncomingCallModal() {
  if (globalIncomingModal) globalIncomingModal.style.display = 'none';
  stopRingtone();
  if (ringTimeout) clearTimeout(ringTimeout);
}

// ========== CALL DATABASE FUNCTIONS ==========
async function saveCallRecord(callerId, receiverId, callType, callStatus, duration, chatId) {
  try {
    const response = await fetch(`${API_URL}/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerId, receiverId, callType, callStatus, duration, chatId })
    });
    const data = await response.json();
    return data.id;
  } catch (err) {
    console.error('Failed to save call record:', err);
    return null;
  }
}

async function updateCallRecord(callId, callStatus, duration) {
  try {
    await fetch(`${API_URL}/calls/${callId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callStatus, duration, endedAt: new Date() })
    });
  } catch (err) {
    console.error('Failed to update call record:', err);
  }
}

// ========== END CALL WITH PROPER CLEANUP ==========
async function endGlobalCall(emitEndSignal = true) {
  console.log('📞 Ending call');
  
  if (callStartTime && currentCallId && emitEndSignal) {
    const duration = Math.floor((Date.now() - callStartTime) / 1000);
    await updateCallRecord(currentCallId, 'ended', duration);
    
    if (globalSocket && currentChatId) {
      globalSocket.emit('end-call', { 
        callId: currentCallId, 
        duration: duration,
        chatId: currentChatId
      });
    }
  }
  
  if (activePeerConnection) {
    activePeerConnection.close();
    activePeerConnection = null;
  }
  if (activeLocalStream) {
    activeLocalStream.getTracks().forEach(track => track.stop());
    activeLocalStream = null;
  }
  
  // REAL FIX: Completely destroy the call UI
  destroyCallUI();
  
  hideCallBanner();
  hideIncomingCallModal();
  isCallPeekMode = false;
  clearPersistedCallState();
  
  isInCall = false;
  callStartTime = null;
  currentCallId = null;
  currentChatId = null;
  currentCallType = null;
  currentOtherUserId = null;
  
  if (controlsTimeout) clearTimeout(controlsTimeout);
  
  // Reset flags
  isCreatingCallUI = false;
}

// ========== START CALL ==========
async function startCall(toUserId, callType) {
  if (isInCall) {
    alert('Already in a call');
    return;
  }
  
  console.log('📞 Starting ' + callType + ' call to:', toUserId);

  if (!currentUser) {
    currentUser = JSON.parse(localStorage.getItem('user') || 'null');
  }

  currentOtherUserId = toUserId;
  currentCallType = callType;
  currentCallPeerId = toUserId;
  currentCallPeerName = null;
  currentCallPeerPhoto = null;
  currentCallLocalProfileName = getUserDisplayName(currentUser, 'You');
  currentCallLocalProfilePhoto = getUserPhoto(currentUser);
  const chatId = `${Math.min(currentUser.id, toUserId)}-${Math.max(currentUser.id, toUserId)}`;
  currentChatId = chatId;
  
  currentCallId = await saveCallRecord(currentUser.id, toUserId, callType, 'ringing', 0, chatId);
  persistCallState({
    status: 'ringing',
    callType,
    remoteUserId: toUserId,
    remoteName: null,
    chatId,
    currentCallId,
    shouldShowCallScreen: false,
    minimized: true
  });
  
  const remoteUser = await loadUserProfile(toUserId);
  const mediaElements = createCallMediaElements();
  if (!mediaElements) {
    console.error('Failed to create call UI');
    return;
  }
  
  setCallIdentityOverlayVisibility(true);
  renderIdentityOverlay(mediaElements.remoteIdentityOverlay, remoteUser, `User ${toUserId}`, callType === 'video' ? 'Video call' : 'Audio call', 78, false);
  renderIdentityOverlay(mediaElements.localIdentityOverlay, currentUser, 'You', 'Preview', 46, true);
  if (callType === 'video') {
    mediaElements.remoteVideo.style.display = 'block';
    mediaElements.localVideo.style.display = 'block';
    mediaElements.badge.style.display = 'block';
    mediaElements.badge.textContent = '📹 Video Call';
  } else {
    mediaElements.remoteVideo.style.display = 'block';
    mediaElements.localVideo.style.display = 'none';
    mediaElements.badge.style.display = 'block';
    mediaElements.badge.textContent = '📞 Audio Call';
  }
  showCallMedia();
  persistCallState({ status: 'ringing', callType, remoteUserId: toUserId, chatId, currentCallId, shouldShowCallScreen: false, minimized: true });
  showCallBanner('Calling...');
  isInCall = true;
  callStartTime = Date.now();
  
  try {
    const mediaConstraints = { audio: true, video: callType === 'video' };
    activeLocalStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
    if (callType === 'video' && mediaElements.localVideo) {
      mediaElements.localVideo.srcObject = activeLocalStream;
    }
    
    activePeerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
    });
    
    activeLocalStream.getTracks().forEach(track => {
      activePeerConnection.addTrack(track, activeLocalStream);
    });
    
    activePeerConnection.ontrack = (event) => {
      console.log('📞 Received remote track');
      const remoteVideo = document.getElementById('remoteVideo');
      if (remoteVideo) {
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.style.display = 'block';
      }
    };
    
    activePeerConnection.onicecandidate = (event) => {
      if (event.candidate && globalSocket) {
        globalSocket.emit('signal', {
          to: currentOtherUserId,
          senderId: currentUser.id,
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };
    
    activePeerConnection.onconnectionstatechange = () => {
      console.log('📞 Connection state:', activePeerConnection.connectionState);
      if (activePeerConnection.connectionState === 'connected') {
        updateCallBannerStatus('Connected');
        persistCallState({ status: 'connected', shouldShowCallScreen: false, minimized: true, videoPaused: currentCallType === 'video' });
        if (currentCallType === 'video') {
          setCallIdentityOverlayVisibility(false);
          enterCallPeekMode();
        }
      } else if (['disconnected', 'failed', 'closed'].includes(activePeerConnection.connectionState)) {
        endGlobalCall();
      }
    };
    
    const offer = await activePeerConnection.createOffer();
    await activePeerConnection.setLocalDescription(offer);
    
    if (globalSocket) {
      globalSocket.emit('start-call', {
        to: toUserId,
        from: currentUser.id,
        callType: callType,
        chatId: chatId,
        sdp: offer.sdp,
        callId: currentCallId
      });
    }
    
    updateCallBannerStatus('Ringing...');
    console.log('📞 Offer sent');
  } catch (err) {
    console.error('Failed to start call:', err);
    alert('Unable to access microphone/camera. Please check permissions.');
    endGlobalCall();
  }
}

// ========== ACCEPT CALL ==========
async function acceptGlobalCall() {
  if (!globalPendingCall) return;
  
  hideIncomingCallModal();
  console.log('📞 Accepting ' + globalPendingCall.callType + ' call from:', globalPendingCall.from);
  
  currentOtherUserId = globalPendingCall.from;
  currentCallType = globalPendingCall.callType;
  currentCallId = globalPendingCall.callId;
  currentChatId = globalPendingCall.chatId;
  currentCallPeerName = globalPendingCall.callerName || `User ${globalPendingCall.from}`;
  currentCallPeerPhoto = globalPendingCall.callerPhoto || null;
  currentCallLocalProfileName = getUserDisplayName(currentUser, 'You');
  currentCallLocalProfilePhoto = getUserPhoto(currentUser);
  
  const callerUser = await loadUserProfile(globalPendingCall.from);
  const mediaElements = createCallMediaElements();
  if (!mediaElements) {
    console.error('Failed to create call UI');
    return;
  }
  
  setCallIdentityOverlayVisibility(true);
  renderIdentityOverlay(mediaElements.remoteIdentityOverlay, callerUser, globalPendingCall.callerName || `User ${globalPendingCall.from}`, currentCallType === 'video' ? 'Video call' : 'Audio call', 78, false);
  renderIdentityOverlay(mediaElements.localIdentityOverlay, currentUser, 'You', 'Preview', 46, true);
  if (currentCallType === 'video') {
    mediaElements.remoteVideo.style.display = 'block';
    mediaElements.localVideo.style.display = 'block';
    mediaElements.badge.style.display = 'block';
    mediaElements.badge.textContent = '📹 Video Call';
  } else {
    mediaElements.remoteVideo.style.display = 'block';
    mediaElements.localVideo.style.display = 'none';
    mediaElements.badge.style.display = 'block';
    mediaElements.badge.textContent = '📞 Audio Call';
  }
  showCallMedia();
  persistCallState({ status: 'connected', callType: currentCallType, remoteUserId: globalPendingCall.from, remoteName: globalPendingCall.callerName || null, chatId: currentChatId, currentCallId, shouldShowCallScreen: false, minimized: true });
  showCallBanner('Connecting...');
  isInCall = true;
  callStartTime = Date.now();
  
  await updateCallRecord(currentCallId, 'answered', 0);
  
  if (globalSocket) {
    globalSocket.emit('accept-call', {
      to: globalPendingCall.from,
      from: currentUser.id,
      callId: currentCallId,
      chatId: currentChatId
    });
  }
  
  try {
    const mediaConstraints = { audio: true, video: currentCallType === 'video' };
    activeLocalStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
    if (currentCallType === 'video' && mediaElements.localVideo) {
      mediaElements.localVideo.srcObject = activeLocalStream;
    }
    
    activePeerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
    });
    
    activeLocalStream.getTracks().forEach(track => {
      activePeerConnection.addTrack(track, activeLocalStream);
    });
    
    activePeerConnection.ontrack = (event) => {
      console.log('📞 Received remote track');
      const remoteVideo = document.getElementById('remoteVideo');
      if (remoteVideo) {
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.style.display = 'block';
      }
    };
    
    activePeerConnection.onicecandidate = (event) => {
      if (event.candidate && globalSocket) {
        globalSocket.emit('signal', {
          to: currentOtherUserId,
          senderId: currentUser.id,
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };
    
    activePeerConnection.onconnectionstatechange = () => {
      console.log('📞 Connection state:', activePeerConnection.connectionState);
      if (activePeerConnection.connectionState === 'connected') {
        updateCallBannerStatus('Connected');
        persistCallState({ status: 'connected', shouldShowCallScreen: false, minimized: true, videoPaused: currentCallType === 'video' });
        if (currentCallType === 'video') {
          setCallIdentityOverlayVisibility(false);
          enterCallPeekMode();
        }
      } else if (['disconnected', 'failed', 'closed'].includes(activePeerConnection.connectionState)) {
        endGlobalCall();
      }
    };
    
    await activePeerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: globalPendingCall.sdp }));
    const answer = await activePeerConnection.createAnswer();
    await activePeerConnection.setLocalDescription(answer);
    
    if (globalSocket) {
      globalSocket.emit('signal', {
        to: currentOtherUserId,
        senderId: currentUser.id,
        type: 'answer',
        sdp: answer.sdp,
        callId: currentCallId
      });
    }
    
    updateCallBannerStatus('Connected');
    console.log('📞 Answer sent, call connected');
  } catch (err) {
    console.error('Failed to accept call:', err);
    alert('Unable to access microphone/camera. Please check permissions.');
    endGlobalCall();
  }
  
  globalPendingCall = null;
}

// ========== DECLINE CALL ==========
async function declineGlobalCall() {
  if (!globalPendingCall) return;
  hideIncomingCallModal();
  console.log('📞 Declining call from:', globalPendingCall.from);
  if (globalSocket && globalPendingCall.callId) {
    globalSocket.emit('decline-call', {
      to: globalPendingCall.from,
      callId: globalPendingCall.callId,
      chatId: globalPendingCall.chatId
    });
    await updateCallRecord(globalPendingCall.callId, 'missed', 0);
  }
  globalPendingCall = null;
}

function showIncomingCall(callerName, callerId, callType, callId, chatId, sdp, callerPhoto) {
  showIncomingCallModal(callerName, callerId, callType, callId, chatId, sdp, callerPhoto);
}

// ========== SOCKET INITIALIZATION ==========
async function initGlobalSocket() {
  if (typeof io === 'undefined') {
    setTimeout(initGlobalSocket, 500);
    return;
  }
  
  currentUser = JSON.parse(localStorage.getItem('user') || 'null');
  if (!currentUser || !currentUser.id) return;
  currentCallLocalProfileName = getUserDisplayName(currentUser, 'You');
  currentCallLocalProfilePhoto = getUserPhoto(currentUser);
  if (globalSocket && globalSocket.connected) return;
  
  globalSocket = io(SOCKET_URL, { 
    transports: ['websocket', 'polling'], 
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });
  
  globalSocket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
    const statusDiv = document.getElementById('connectionStatus');
    if (statusDiv) {
      statusDiv.className = 'connection-status disconnected';
      statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Connecting to server...';
      statusDiv.style.display = 'flex';
    }
  });

  globalSocket.on('reconnect', (attemptNumber) => {
    console.log(`Socket reconnected after ${attemptNumber} attempts`);
    if (currentUser && currentUser.id) {
      globalSocket.emit('register-user', currentUser.id);
    }
    const statusDiv = document.getElementById('connectionStatus');
    if (statusDiv) {
      statusDiv.className = 'connection-status connected';
      statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> Reconnected';
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 3000);
    }
  });
  
  globalSocket.on('connect', () => {
    console.log('🌐 Global socket connected');
    globalSocket.emit('register-user', currentUser.id);
  });
  
  globalSocket.on('incoming-call', (data) => {
    console.log('📞 Incoming call received:', data);
    if (data.from == currentUser.id) return;
    persistCallState({ status: 'ringing', callType: data.callType, remoteUserId: data.from, remoteName: null, chatId: data.chatId, currentCallId: data.callId, shouldShowCallScreen: false, minimized: true });
    fetch(`${API_URL}/user/${data.from}`)
      .then(res => res.json())
      .then(user => {
        const callerName = user?.name || `User ${data.from}`;
        const callerPhoto = getUserPhoto(user);
        persistCallState({ remoteName: callerName });
        showIncomingCall(callerName, data.from, data.callType, data.callId, data.chatId, data.sdp, callerPhoto);
      })
      .catch(() => showIncomingCall(`User ${data.from}`, data.from, data.callType, data.callId, data.chatId, data.sdp, null));
  });
  
  globalSocket.on('call-accepted', (data) => {
    console.log('📞 Call accepted by remote:', data);
    hideIncomingCallModal();
    updateCallBannerStatus('Connected');
  });
  
  globalSocket.on('call-declined', (data) => {
    console.log('📞 Call declined by remote:', data);
    hideIncomingCallModal();
    endGlobalCall();
  });
  
  globalSocket.on('call-ended', (data) => {
    console.log('📞 Call ended by remote:', data);
    endGlobalCall(false);
  });

  globalSocket.on('chat-notification', (data) => {
    if (!data || !data.chatId) return;
    if (window.location.pathname.endsWith('chat.html') && window.currentChatId && String(window.currentChatId) === String(data.chatId)) {
      return;
    }
    showPageNotification({
      title: data.title || 'New message',
      body: data.body || (data.type === 'text' ? data.text : data.type === 'voice' ? 'Voice note received' : data.type === 'media' ? 'Media attachment received' : 'New chat message'),
      chatId: data.chatId,
      fromUser: data.from
    });
  });
  
  globalSocket.on('signal', async (data) => {
    if (!activePeerConnection) return;
    try {
      if (data.type === 'answer') {
        await activePeerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
        console.log('📞 Remote answer set');
      } else if (data.type === 'candidate') {
        await activePeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        console.log('📞 ICE candidate added');
      }
    } catch (err) { console.warn('Signal error:', err); }
  });
  
  globalSocket.on('disconnect', () => { console.log('🌐 Global socket disconnected'); });
}

function restorePersistedCallUI() {
  const state = getPersistedCallState();
  if (!state || !state.status || state.status === 'idle') return;
  if (state.status === 'ringing' || state.status === 'connected') {
    showCallBanner(state.status === 'connected' ? 'Connected' : 'Ringing...');
  }
  if (state.status === 'connected' && state.callType === 'video' && state.shouldShowCallScreen) {
    showCallMedia();
  }
}

function ensurePageNotificationContainer() {
  let container = document.getElementById('pageNotificationContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'pageNotificationContainer';
    container.className = 'page-notification-container';
    document.body.appendChild(container);
  }
  return container;
}

function showPageNotification({ title, body, chatId, fromUser }) {
  const container = ensurePageNotificationContainer();
  const toast = document.createElement('div');
  toast.className = 'page-notification';
  toast.innerHTML = `<strong>${sanitizeText(title)}</strong><p>${sanitizeText(body)}</p>`;
  toast.addEventListener('click', () => {
    if (fromUser) {
      window.location.href = `chat.html?with=${fromUser}`;
    }
  });
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => toast.classList.remove('visible'), 5000);
  setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 5400);
}

function sanitizeText(text) {
  if (text === undefined || text === null) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ========== CALL BUTTON HANDLERS ==========
window.startCall = startCall;
document.addEventListener('click', (e) => {
  const audioBtn = e.target.closest('#audioCallBtn');
  const videoBtn = e.target.closest('#videoCallBtn');
  if (audioBtn) {
    e.preventDefault();
    const otherUserId = new URLSearchParams(location.search).get('with');
    if (otherUserId) startCall(otherUserId, 'audio');
    else alert('Select a user to call first');
  } else if (videoBtn) {
    e.preventDefault();
    const otherUserId = new URLSearchParams(location.search).get('with');
    if (otherUserId) startCall(otherUserId, 'video');
    else alert('Select a user to call first');
  }
});

// ===== HELPER FUNCTIONS FOR API CALLS =====
window.safeFetch = async function(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`;
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        },
        ...options
    };
    
    try {
        const response = await fetch(fullUrl, defaultOptions);
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Request failed' }));
            throw new Error(error.message || `HTTP ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error('API call failed:', error);
        throw error;
    }
};

window.isAuthenticated = function() {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    return user && user.id;
};

window.getAuthHeaders = function() {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    return {
        'Content-Type': 'application/json',
        'user-id': user?.id || ''
    };
};

// ==================== WELCOME TOAST NOTIFICATION ====================
window.showWelcomeToast = function(userName, isNewUser = false) {
    if (sessionStorage.getItem('welcomeToastShown') === 'true') {
        return;
    }
    
    let toastContainer = document.getElementById('welcomeToastContainer');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'welcomeToastContainer';
        toastContainer.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 10000;
            max-width: 350px;
            width: calc(100% - 40px);
        `;
        document.body.appendChild(toastContainer);
    }
    
    const toast = document.createElement('div');
    toast.className = 'welcome-toast';
    toast.style.cssText = `
        background: linear-gradient(135deg, #2563eb 0%, #8b5cf6 100%);
        color: white;
        border-radius: 16px;
        padding: 16px 20px;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 14px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.2);
        transform: translateX(400px);
        transition: transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        cursor: pointer;
    `;
    
    const emoji = isNewUser ? '🎉' : '👋';
    const title = isNewUser ? `Welcome to LaborConnect, ${userName || 'there'}!` : `Welcome back, ${userName || 'there'}!`;
    const message = isNewUser 
        ? "We're excited to have you on board. Start exploring today!" 
        : "Great to see you again. Ready to connect with professionals?";
    
    toast.innerHTML = `
        <div style="background: rgba(255,255,255,0.2); border-radius: 50%; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; font-size: 22px;">
            ${emoji}
        </div>
        <div style="flex: 1;">
            <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px;">${title}</div>
            <div style="font-size: 12px; opacity: 0.9;">${message}</div>
        </div>
        <button class="close-toast" style="background: rgba(255,255,255,0.2); border: none; color: white; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;">
            <i class="fas fa-times" style="font-size: 12px;"></i>
        </button>
    `;
    
    toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.transform = 'translateX(0)';
    }, 100);
    
    const closeBtn = toast.querySelector('.close-toast');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeToast(toast);
    });
    
    toast.addEventListener('click', (e) => {
        if (e.target.closest('.close-toast')) return;
        closeToast(toast);
    });
    
    setTimeout(() => {
        closeToast(toast);
    }, 6000);
    
    function closeToast(toastElement) {
        toastElement.style.transform = 'translateX(400px)';
        setTimeout(() => {
            if (toastElement.parentNode) {
                toastElement.remove();
            }
        }, 300);
    }
    
    sessionStorage.setItem('welcomeToastShown', 'true');
};

window.checkAndShowWelcome = function() {
    const urlParams = new URLSearchParams(window.location.search);
    const welcomeType = urlParams.get('welcome');
    const userName = urlParams.get('name') || '';
    
    if (welcomeType === 'new' || welcomeType === 'return') {
        window.showWelcomeToast(decodeURIComponent(userName), welcomeType === 'new');
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
    }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    restorePersistedCallUI();
    setTimeout(initGlobalSocket, 100);
    window.checkAndShowWelcome();
  });
} else {
  restorePersistedCallUI();
  setTimeout(initGlobalSocket, 100);
  window.checkAndShowWelcome();
}
window.addEventListener('pageshow', () => {
    restorePersistedCallUI();
    window.checkAndShowWelcome();
});

window.stopRingtone = stopRingtone;
window.playRingtone = playRingtone;
window.endGlobalCall = endGlobalCall;
window.globalSocket = () => globalSocket;

} // End of __COMMON_CALLS_LOADED__