(() => {
  // ------------------------------
  // Global Variables & Cache Setup
  // ------------------------------
  const PROCESSED_MARKER = 'data-ghu-processed';
  const CACHE_KEY = "githubDisplayNameCache";
  const displayNames = {};    // username => fetched display name
  const elementsByUsername = {}; // username => array of update callbacks

  // Helper: Get the cache from chrome.storage.local.
  function getCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get([CACHE_KEY], (result) => {
        resolve(result[CACHE_KEY] || {});
      });
    });
  }

  // Register an update callback for an element associated with a username.
  // When we have the display name, the callback will be invoked.
  function registerElement(username, updateCallback) {
    if (!elementsByUsername[username]) {
      elementsByUsername[username] = [];
    }
    elementsByUsername[username].push(updateCallback);
  }

  /**
   * Call all registered callbacks for a username once, then clear them out.
   */
  function updateElements(username) {
    const callbacks = elementsByUsername[username];
    if (!callbacks) return;

    const name = displayNames[username] || username;
    // Ensure we only run each callback a single time
    delete elementsByUsername[username];

    callbacks.forEach((cb) => {
      try {
        cb(name);
      } catch (e) {
        console.error("Error updating element for @" + username, e);
      }
    });
  }

  /**
   * Walk all text nodes under `element`, replace @username or username tokens
   * with the displayName—but skip any node that already contains the full displayName.
   */
  function updateTextNodes(element, username, displayName) {
    // Escape special regex chars in the username
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match standalone @username or username (doesn't run inside other words)
    const regex = new RegExp(`(?<!\\w)@?${escapedUsername}(?!\\w)`, "g");

    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    let node;
    let changed = false;
    while ((node = walker.nextNode())) {
      // If we've already inserted the full displayName here, skip it
      if (node.textContent.includes(displayName)) {
        // If the display name is already present, we assume it's fully correct.
        // This is simpler and might be more robust for cases like TBBle.
        // However, this means if a username token still exists that *should* be replaced,
        // and the displayName is also part of another text node, it might be skipped.
        // The PROCESSED_MARKER should ideally prevent re-entry for the whole element.
        // This change makes updateTextNodes itself more idempotent if called multiple times
        // on the same text that already contains the final display name.
        continue;
      }

      const updated = node.textContent.replace(regex, (match) =>
        match.startsWith("@") ? `@${displayName}` : displayName
      );
      if (updated !== node.textContent) {
        node.textContent = updated;
        changed = true;
      }
    }
    return changed;
  }

  // ------------------------------
  // Fetching & Caching Display Names
  // ------------------------------
  async function fetchDisplayName(username) {
    // Only look up in cache if not already present in displayNames
    if (displayNames[username]) {
      updateElements(username);
      return;
    }
    try {
      let cache = await getCache();
      const serverCache = cache[location.hostname] || {};
      let entry = serverCache[username];

      if (entry) {
        displayNames[username] = entry.displayName;
        updateElements(username);
        return;
      }

      // Request the lock from the background service.
      const lockResponse = await chrome.runtime.sendMessage({
        type: "acquireLock",
        origin: location.hostname,
        username: username
      });

      if (lockResponse.acquired) {
        // We have the lock—fetch the GitHub profile page.
        const profileUrl = `https://${location.hostname}/${username}`;
        const response = await fetch(profileUrl);
        if (!response.ok) {
          throw new Error("HTTP error " + response.status);
        }
        const html = await response.text();

        // Parse the HTML using a DOMParser.
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const el = doc.querySelector('.vcard-fullname');
        let displayName = el ? el.textContent.trim() : username;

        // Tell the background to update the cache and release the lock.
        await chrome.runtime.sendMessage({
          type: "releaseLock",
          origin: location.hostname,
          username: username,
          displayName: displayName
        });

        displayNames[username] = displayName;
        updateElements(username);
      } else {
        // Another content script is already fetching this profile.
        // Poll until the cache is updated.
        const maxAttempts = 10;
        let attempt = 0;
        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        while (attempt < maxAttempts) {
          await wait(500);
          let cache = await getCache();
          const serverCache = cache[location.hostname] || {};
          let entry = serverCache[username];
          if (entry) {
            displayNames[username] = entry.displayName;
            updateElements(username);
            return;
          }
          attempt++;
        }
        // Fallback if we still haven't received a display name.
        displayNames[username] = username;
        updateElements(username);
      }
    } catch (err) {
      console.error("Error fetching display name for @" + username, err);
      displayNames[username] = username;
      updateElements(username);
    }
  }

  // ------------------------------
  // DOM Processing Functions
  // ------------------------------

// Function to update the element directly
function updateElementDirectly(element, username, displayName) {
  let changed = false;
  
  // For h3 elements that contain usernames (found via avatar association)
  if (element.tagName === 'H3' && element.textContent.trim() === username) {
    // Only replace if the text exactly matches the username (no partial replacements)
    if (element.textContent.trim() === username) {
      element.textContent = displayName;
      changed = true;
    }
  } else if (element.tagName === 'IMG' && element.dataset.testid === 'github-avatar') {
    if (element.alt === displayName) return false; // Already updated
    element.alt = displayName;
    changed = true;
  } else if (element.tagName === 'SPAN' && element.hasAttribute('aria-label')) {
    if (element.getAttribute('aria-label') === displayName) return false; // Already updated
    element.setAttribute('aria-label', displayName);
    changed = true;
  }
  return changed;
}

// Function to find username text associated with an avatar
function findUsernameFromAvatar(avatarImg) {
  // Start from the avatar and traverse up to find the containing item
  let container = avatarImg.closest('li, div[class*="item"], div[class*="row"], button');
  if (!container) return null;
  
  // Look for h3, span, or div elements that might contain the username
  // Prioritize h3 tags as they commonly contain the username in project views
  const possibleUsernameElements = container.querySelectorAll('h3, span[class*="title"], div[class*="title"], span[class*="name"], div[class*="name"]');
  
  for (const elem of possibleUsernameElements) {
    const text = elem.textContent.trim();
    // Basic validation: usernames are typically alphanumeric with hyphens/underscores
    // and don't contain spaces (unless it's already a display name)
    if (text && !text.includes(' ') && /^[a-zA-Z0-9\-_]+$/.test(text)) {
      return { element: elem, username: text };
    }
  }
  
  // Fallback: use the alt text of the image itself if it looks like a username
  const altText = avatarImg.alt.trim();
  if (altText && altText !== "" && !altText.includes(' ')) {
    return { element: null, username: altText };
  }
  
  return null;
}

// Function to process project elements using avatar-based detection
function processProjectElements(root) {
  if (!(root instanceof Element)) return; // Ensure root is an Element

  // Find all avatar images - this is a stable selector across GitHub versions
  const avatarSelector = 'img[data-testid="github-avatar"], img[data-component="Avatar"]';
  
  let avatarsToProcess = [];

  // Check if root itself is an avatar
  if (root.matches(avatarSelector)) {
    avatarsToProcess.push(root);
  }

  // Add descendant avatars
  avatarsToProcess.push(...Array.from(root.querySelectorAll(avatarSelector)));

  avatarsToProcess.forEach(avatarImg => {
    // Skip if already processed
    if (avatarImg.hasAttribute(PROCESSED_MARKER)) return;
    
    // Skip "No Assignees" or bot avatars
    const altText = avatarImg.alt || "";
    if (altText === "No Assignees" || altText === "" || altText.includes('[bot]')) {
      return;
    }
    
    // Find the username element associated with this avatar
    const usernameInfo = findUsernameFromAvatar(avatarImg);
    if (!usernameInfo || !usernameInfo.username) return;
    
    const username = usernameInfo.username;
    
    // Process the avatar's alt text
    if (displayNames[username]) {
      avatarImg.alt = displayNames[username];
      avatarImg.setAttribute(PROCESSED_MARKER, 'true');
      
      // Also update the associated text element if found
      if (usernameInfo.element && !usernameInfo.element.hasAttribute(PROCESSED_MARKER)) {
        usernameInfo.element.textContent = displayNames[username];
        usernameInfo.element.setAttribute(PROCESSED_MARKER, 'true');
      }
    } else {
      // Register callbacks for when the display name is fetched
      registerElement(username, (displayName) => {
        avatarImg.alt = displayName;
        avatarImg.setAttribute(PROCESSED_MARKER, 'true');
        
        // Update the associated text element
        if (usernameInfo.element && !usernameInfo.element.hasAttribute(PROCESSED_MARKER)) {
          usernameInfo.element.textContent = displayName;
          usernameInfo.element.setAttribute(PROCESSED_MARKER, 'true');
        }
      });
      fetchDisplayName(username);
    }
  });
  
  // Also process any standalone username elements that might not have avatars
  // This handles edge cases where usernames appear without avatars
  processStandaloneUsernames(root);
}

// Function to process usernames that appear without avatars (edge cases)
function processStandaloneUsernames(root) {
  if (!(root instanceof Element)) return;
  
  // Look for elements that commonly contain usernames in project views
  // Use more generic selectors that work across GitHub versions
  const selectors = [
    'a[href^="/"][href$=""]:not([href*="/"])', // Direct user profile links
    'span[aria-label]:not([' + PROCESSED_MARKER + '])', // Spans with aria-labels that might be usernames
  ];
  
  selectors.forEach(selector => {
    let elements = [];
    if (root.matches(selector)) {
      elements.push(root);
    }
    elements.push(...Array.from(root.querySelectorAll(selector)));
    
    elements.forEach(element => {
      if (element.hasAttribute(PROCESSED_MARKER)) return;
      
      let username = null;
      
      // Extract username from href if it's a link
      if (element.tagName === 'A') {
        const href = element.getAttribute('href');
        const match = href.match(/^\/([a-zA-Z0-9\-_]+)$/);
        if (match) {
          username = match[1];
        }
      } else if (element.hasAttribute('aria-label')) {
        const label = element.getAttribute('aria-label').trim();
        if (label && /^[a-zA-Z0-9\-_]+$/.test(label)) {
          username = label;
        }
      }
      
      if (!username || username === "No Assignees") return;
      
      if (displayNames[username]) {
        if (element.tagName === 'A') {
          updateTextNodes(element, username, displayNames[username]);
        } else if (element.hasAttribute('aria-label')) {
          element.setAttribute('aria-label', displayNames[username]);
        }
        element.setAttribute(PROCESSED_MARKER, 'true');
      } else {
        registerElement(username, (displayName) => {
          if (element.tagName === 'A') {
            updateTextNodes(element, username, displayName);
          } else if (element.hasAttribute('aria-label')) {
            element.setAttribute('aria-label', displayName);
          }
          element.setAttribute(PROCESSED_MARKER, 'true');
        });
        fetchDisplayName(username);
      }
    });
  });
}

  /**
   * Processes anchor tags that have a data-hovercard-url starting with "/users/", or
   * have a hovercard-link-click attribute.
   * For each such anchor:
   * - If its content is solely a <span class="AppHeader-context-item-label">, skip it.
   * - Otherwise, register a callback so that once the display name is available, every text node within the anchor
   *   that contains the username (or "@username") is updated to the display name.
   */
  function processAnchorsByHovercard(root) {
    if (!(root instanceof Element)) return; // Ensure root is an Element

    const selector = 'a[data-hovercard-url^="/users/"], a[data-octo-click="hovercard-link-click"]';
    let elementsToProcess = [];

    if (root.matches(selector)) {
      elementsToProcess.push(root);
    }
    // Add descendants, ensuring not to add duplicates if root itself was captured by querySelectorAll from a higher level
    // However, PROCESSED_MARKER handles actual duplicate processing effectively.
    elementsToProcess.push(...Array.from(root.querySelectorAll(selector)));

    // If root itself matches and is also found by querySelectorAll (e.g. if root is child of itself, which is not possible)
    // a simple Set could deduplicate: elementsToProcess = Array.from(new Set(elementsToProcess));
    // But given PROCESSED_MARKER, explicit deduplication here is likely not critical.

    elementsToProcess.forEach((anchor) => {
      if (anchor.hasAttribute(PROCESSED_MARKER)) return;

      // Exception: if the anchor's entire content is a single span with the specified class and text, skip processing.
      if (anchor.children.length === 1) {
        const child = anchor.children[0];
        if (
          child.tagName === "SPAN" &&
          child.classList.contains("AppHeader-context-item-label")
        ) {
          return;
        }
      }

      // Extract the username.
      const username = getUsername(anchor);
      if (!username) return;

      // If the display name is already available, update immediately; otherwise, fetch it.
      if (displayNames[username]) {
        const updated = updateTextNodes(anchor, username, displayNames[username]);
        if (updated) {
          anchor.setAttribute(PROCESSED_MARKER, 'true');
        }
      } else {
        registerElement(username, (displayName) => {
          const updated = updateTextNodes(anchor, username, displayName);
          if (updated) {
            anchor.setAttribute(PROCESSED_MARKER, 'true');
          }
        });
        fetchDisplayName(username);
      }
    });
  }

  // Get the username from the anchor tag, preferring the data-hovercard-url to the href.
  function getUsername(anchor) {
    const hover = anchor.getAttribute("data-hovercard-url");
    const href = anchor.getAttribute("href");
    if (hover) {
      const match = hover.match(/^\/users\/((?!.*%5Bbot%5D)[^\/?]+)/);
      if (match) return match[1];
    }
    else if (href) {
      const match = href.match(/^\/((?!orgs\/)(?!.*%5Bbot%5D)[^\/?]+)\/?$/);
      if (match) return match[1];
    }
    return;
  }

  // Initial processing.
  processAnchorsByHovercard(document.body);
  processProjectElements(document.body);

  // Set up a MutationObserver to handle new elements.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processAnchorsByHovercard(node);
          processProjectElements(node);
        }
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
})();
