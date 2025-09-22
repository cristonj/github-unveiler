// content.test.js

// A helper to flush pending microtasks.
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("content.js", () => {
  let fakeCache;

  beforeEach(() => {
    // Reset modules so that the IIFE in content.js re‑runs freshly.
    jest.resetModules();

    // Clear the document.
    document.body.innerHTML = "";
    // Initialize the fake cache.
    fakeCache = {};

    // --- Set up global chrome mocks ---
    global.chrome = {
      storage: {
        local: {
          get: jest.fn((keys, callback) => {
            // Return the current cache.
            callback({ githubDisplayNameCache: fakeCache });
          }),
          set: jest.fn((obj, callback) => {
            fakeCache = obj.githubDisplayNameCache;
            callback();
          }),
        },
      },
      runtime: {
        sendMessage: jest.fn((msg) => {
          if (msg.type === "acquireLock") {
            // By default, simulate that the lock is acquired.
            return Promise.resolve({ acquired: true });
          }
          if (msg.type === "releaseLock") {
            return Promise.resolve({ success: true });
          }
          return Promise.resolve({});
        }),
      },
    };

    // --- Set up global fetch mock ---
    const mockDisplayNames = {
      'testuser': 'Test User', // Default from previous tests
      'testuser2': 'Test User 2',
      'octouser': 'Test Octo',
      'user123': 'Test User 123',
      'TBBle': 'Paul "TBBle" Hampson',
      'projectUser1': 'Project User One',
      'projectUser2': 'Project User Two',
      'projectUser3': 'Project User Three',
      // Add more as needed for new tests
    };

    global.fetch = jest.fn((url) => {
      const username = url.substring(url.lastIndexOf('/') + 1);
      const displayName = mockDisplayNames[username];

      if (displayName) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(`<html><body><div class="vcard-fullname">${displayName}</div></body></html>`),
        });
      }
      // Fallback for any username not in mockDisplayNames, or if specific error simulation is needed
      return Promise.resolve({
        ok: false, status: 404, text: () => Promise.resolve("Not Found"),
      });
    });

    // --- Set location.hostname ---
    global.location = { hostname: "github.com" };

    // --- Spy on console logging methods ---
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Clear mock call counts
    global.fetch.mockClear();
    if (global.chrome && global.chrome.runtime && global.chrome.runtime.sendMessage) {
      global.chrome.runtime.sendMessage.mockClear();
    }
    // Restore any spied-on objects
    jest.restoreAllMocks();
    // Clear the document body
    document.body.innerHTML = "";
  });

  test("should fetch and update display name on a valid anchor with data-hovercard-url", async () => {
    // Create an anchor that qualifies for processing.
    const anchor = document.createElement("a");
    anchor.setAttribute("data-hovercard-url", "/users/testuser");
    anchor.textContent = "Hello @testuser, welcome!";
    document.body.appendChild(anchor);

    // Load content.js (which processes document.body immediately).
    require("../content.js");

    // Wait for asynchronous tasks to finish.
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));

    // Expect occurrences of "@testuser" to be replaced with "@Test User"
    expect(anchor.textContent).toBe("Hello @Test User, welcome!");
    expect(anchor.getAttribute('data-ghu-processed')).toBe('true');
  });

  test("should fallback to username if fetch fails", async () => {
    // Simulate a failed fetch specifically for 'testuser' for this test
    // Simulate a failed fetch specifically for 'testuser' for this test
    // This completely replaces the global.fetch for the scope of this test.
    global.fetch = jest.fn((url) => {
      if (url.includes('/testuser')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve("Not Found"),
        });
      }
      // For any other URL, also return an error or an unexpected response
      // to ensure only the '/testuser' path is relevant to what this test is trying to achieve.
      return Promise.resolve({
        ok: false,
        status: 500, // Different status to distinguish
        text: () => Promise.resolve("Unexpected call in this test's fetch mock")
      });
    });

    const consoleErrorSpy = jest.spyOn(console, "error");

    const anchor = document.createElement("a");
    anchor.setAttribute("data-hovercard-url", "/users/testuser");
    anchor.textContent = "Hello @testuser, welcome!";
    document.body.appendChild(anchor);

    // Check if a pre-existing observer (from a previous test's content.js) might process this first
    await flushPromises();
    await new Promise(r => setTimeout(r, 50)); // Allow MO time

    // If it's already "Test User", then a prior observer + the beforeEach fetch mock is the issue.
    // This attempts to counteract that for this specific test.
    if (anchor.textContent === "Hello @Test User, welcome!") {
      // console.error("Fallback Test: Anchor text was ALREADY 'Test User'. Resetting for this test's content.js.");
      anchor.textContent = "Hello @testuser, welcome!"; // Reset text
      if (anchor.hasAttribute('data-ghu-processed')) {
        anchor.removeAttribute('data-ghu-processed'); // Remove marker
      }
    } else if (anchor.textContent !== "Hello @testuser, welcome!") {
      // If it's something else entirely, that's an unexpected state.
      // console.error(`Fallback Test: Anchor text was UNEXPECTED: ${anchor.textContent}. Resetting.`);
      anchor.textContent = "Hello @testuser, welcome!";
      if (anchor.hasAttribute('data-ghu-processed')) {
        anchor.removeAttribute('data-ghu-processed');
      }
    }


    require("../content.js");

    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));

    // On error, the fallback is to use the original username.
    expect(anchor.textContent).toBe("Hello @testuser, welcome!");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Error fetching display name for @testuser",
      expect.any(Error)
    );
  });

  test("should skip processing anchor with a single child span having AppHeader-context-item-label", async () => {
    // Create an anchor that should be skipped.
    const anchor = document.createElement("a");
    anchor.setAttribute("data-hovercard-url", "/users/someuser");
    const span = document.createElement("span");
    span.className = "AppHeader-context-item-label";
    span.textContent = "some text";
    anchor.appendChild(span);
    document.body.appendChild(anchor);

    require("../content.js");

    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));

    // The anchor’s content should remain unchanged.
    expect(anchor.innerHTML).toBe(span.outerHTML);
    // And no lock should have been requested.
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test("should update new anchors added via MutationObserver", async () => {
    // Load the content script.
    require("../content.js");

    // Create a container to ensure the MutationObserver remains attached.
    const container = document.createElement("div");
    document.body.appendChild(container);

    // Create a new anchor after the MutationObserver is in place.
    const anchor = document.createElement("a");
    anchor.setAttribute("data-hovercard-url", "/users/testuser2");
    anchor.textContent = "testuser2";
    container.appendChild(anchor);

    // Allow the MutationObserver callback to run.
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));

    expect(anchor.textContent).toBe("Test User 2");
    expect(anchor.getAttribute('data-ghu-processed')).toBe('true');
  });

  test("should extract username from href if data-hovercard-url is missing (handles trailing slash)", async () => {
    // Create an anchor with only an href attribute (with a trailing slash).
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "/user123/");
    anchor.setAttribute("data-octo-click", "hovercard-link-click");
    anchor.textContent = "Welcome @user123!";
    document.body.appendChild(anchor);

    require("../content.js");

    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));

    // Expect the username to be fetched from href and replaced accordingly.
    expect(anchor.textContent).toBe("Welcome @Test User 123!");
    expect(anchor.getAttribute('data-ghu-processed')).toBe('true');
  });

  test("should process anchor with data-octo-click attribute and valid href", async () => {
    // Create an anchor that qualifies via the data-octo-click attribute.
    const anchor = document.createElement("a");
    anchor.setAttribute("data-octo-click", "hovercard-link-click");
    anchor.setAttribute("href", "/octouser");
    anchor.textContent = "Hello @octouser!";
    document.body.appendChild(anchor);

    require("../content.js");

    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));

    // Expect the username extracted from href to be updated.
    expect(anchor.textContent).toBe("Hello @Test Octo!");
    expect(anchor.getAttribute('data-ghu-processed')).toBe('true');
  });

  test("should skip processing anchor if username contains encoded [bot]", async () => {
    // Create an anchor with a data-hovercard-url that includes an encoded [bot].
    const anchor = document.createElement("a");
    anchor.setAttribute("data-hovercard-url", "/users/test%5Bbot%5D");
    anchor.textContent = "Hello @test[bot]!";
    document.body.appendChild(anchor);

    require("../content.js");

    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));

    // Expect no processing; the text remains unchanged.
    expect(anchor.textContent).toBe("Hello @test[bot]!");
    // And no lock message should have been sent.
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('running the script twice on the same anchor duplicates inner username', async () => {
    // 1) Stub fetch to return Paul "TBBle" Hampson
    // Ensure this mock is a jest.fn() so its calls can be tracked if needed for this specific test.
    const tbbleFetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            '<html><body><div class="vcard-fullname">Paul "TBBle" Hampson</div></body></html>'
          ),
      })
    );
    global.fetch = tbbleFetchMock;
  
    // 2) Create an anchor to be processed
    const anchor = document.createElement('a');
    anchor.setAttribute('data-hovercard-url', '/users/TBBle');
    anchor.textContent = 'Hello @TBBle!';
    document.body.appendChild(anchor);
  
    // 3) First load – should replace cleanly once
    require('../content.js');
    await flushPromises();
    await new Promise(r => setTimeout(r, 0));
    expect(anchor.textContent).toBe('Hello @Paul "TBBle" Hampson!');
    expect(anchor.getAttribute('data-ghu-processed')).toBe('true'); // Check marker

    const fetchCallsBeforeSecondLoad = tbbleFetchMock.mock.calls.length;
    const sendMessageCallsBeforeSecondLoad = global.chrome.runtime.sendMessage.mock.calls.length;

    // 4) Reset modules & load again on the same DOM
    jest.resetModules();

    // Re-establish necessary mocks after reset
    global.fetch = tbbleFetchMock; // Crucial: re-use the same mock instance for fetch

    // Store the original sendMessage mock implementation to re-apply it if necessary
    // or create a new one for the second pass. For this test, a fresh spy is fine.
    const newSendMessageMock = jest.fn(msg => {
      if (msg.type === "acquireLock") return Promise.resolve({ acquired: true });
      if (msg.type === "releaseLock") return Promise.resolve({ success: true });
      return Promise.resolve({});
    });

    global.chrome = {
      storage: {
        local: {
          get: jest.fn((keys, callback) => {
            // Simulate cache for TBBle already exists from first run if needed,
            // or empty if we want to test re-fetch attempt (which should be skipped by marker)
            // For this test, the marker should prevent even a cache lookup for TBBle for re-processing.
            // The displayNames map in content.js will be empty after resetModules.
            callback({ githubDisplayNameCache: { /* simulate TBBle potentially cached by background */ } });
          }),
          set: jest.fn((obj, callback) => {
            callback();
          }),
        },
      },
      runtime: {
        sendMessage: newSendMessageMock,
      },
    };
    // location.hostname should persist, but ensure if issues: global.location = { hostname: "github.com" };


    require('../content.js');
    await flushPromises();
    await new Promise(r => setTimeout(r, 0));
  
    // 5) Confirm no runaway duplication
    expect(anchor.textContent).toBe('Hello @Paul "TBBle" Hampson!');
  });

  describe("GitHub Projects Elements", () => {
    test("should update username based on avatar image", async () => {
      // Create a container that simulates a project item
      const container = document.createElement("li");
      
      // Add an avatar image
      const img = document.createElement("img");
      img.setAttribute("data-testid", "github-avatar");
      img.setAttribute("alt", "projectUser1");
      container.appendChild(img);
      
      // Add an h3 with the username
      const h3 = document.createElement("h3");
      h3.textContent = "projectUser1";
      container.appendChild(h3);
      
      document.body.appendChild(container);

      require("../content.js");
      await flushPromises();

      expect(img.getAttribute("alt")).toBe("Project User One");
      expect(h3.textContent).toBe("Project User One");
      expect(img.getAttribute('data-ghu-processed')).toBe('true');
      expect(h3.getAttribute('data-ghu-processed')).toBe('true');
    });

    test("should update avatar alt text and find associated username element", async () => {
      // Create a more realistic structure with avatar in a container
      const button = document.createElement("button");
      
      const img = document.createElement("img");
      img.setAttribute("data-testid", "github-avatar");
      img.setAttribute("alt", "projectUser2");
      button.appendChild(img);
      
      // Add a span that contains the username
      const span = document.createElement("span");
      span.className = "some-title-class";
      span.textContent = "projectUser2";
      button.appendChild(span);
      
      document.body.appendChild(button);

      require("../content.js");
      await flushPromises();

      expect(img.getAttribute("alt")).toBe("Project User Two");
      expect(span.textContent).toBe("Project User Two");
      expect(img.getAttribute('data-ghu-processed')).toBe('true');
    });

    test("should handle avatars with data-component='Avatar' attribute", async () => {
      // Test the alternative avatar selector
      const div = document.createElement("div");
      div.className = "item-container";
      
      const img = document.createElement("img");
      img.setAttribute("data-component", "Avatar");
      img.setAttribute("alt", "projectUser3");
      div.appendChild(img);
      
      const h3 = document.createElement("h3");
      h3.textContent = "projectUser3";
      div.appendChild(h3);
      
      document.body.appendChild(div);

      require("../content.js");
      await flushPromises();

      expect(img.getAttribute("alt")).toBe("Project User Three");
      expect(h3.textContent).toBe("Project User Three");
      expect(img.getAttribute('data-ghu-processed')).toBe('true');
    });

    test("should update dynamically added project elements with avatars (MutationObserver)", async () => {
      require("../content.js"); // Load content.js first to set up observer

      const container = document.createElement("div");
      container.className = "project-item";
      
      const img = document.createElement("img");
      img.setAttribute("data-testid", "github-avatar");
      img.setAttribute("alt", "projectUser1");
      container.appendChild(img);
      
      const h3 = document.createElement("h3");
      h3.textContent = "projectUser1";
      container.appendChild(h3);
      
      document.body.appendChild(container);

      await flushPromises();
      // Additional small delay for MutationObserver, similar to existing test
      await new Promise(r => setTimeout(r, 50));

      expect(img.getAttribute("alt")).toBe("Project User One");
      expect(h3.textContent).toBe("Project User One");
      expect(img.getAttribute('data-ghu-processed')).toBe('true');
    });

    test("should not process 'No Assignees' and not call fetch", async () => {
      const img = document.createElement("img");
      img.setAttribute("data-testid", "github-avatar");
      img.setAttribute("alt", "No Assignees");
      
      const h3 = document.createElement("h3");
      h3.textContent = "No Assignees";
      
      const container = document.createElement("div");
      container.appendChild(img);
      container.appendChild(h3);
      document.body.appendChild(container);

      // Spy on fetch specifically for this test, though it shouldn't be called for "No Assignees"
      const fetchSpy = global.fetch;

      require("../content.js");
      await flushPromises();

      expect(img.getAttribute("alt")).toBe("No Assignees");
      expect(h3.textContent).toBe("No Assignees");
      expect(img.hasAttribute('data-ghu-processed')).toBe(false);

      // Check that fetch was not called for "No Assignees"
      // The easiest way is to ensure no call to fetch had '/No%20Assignees' (URL encoded space)
      // or just check call counts if no other fetch is expected.
      // Given the setup, fetch might be called for other elements if tests are run in parallel or share state.
      // So, more specific check:
      let calledForNoAssignees = false;
      for (const call of fetchSpy.mock.calls) {
        if (call[0].includes("/No%20Assignees") || call[0].includes("/No Assignees")) {
          calledForNoAssignees = true;
          break;
        }
      }
      expect(calledForNoAssignees).toBe(false);
      // Also ensure sendMessage was not called for 'No Assignees' for lock acquisition
      let sendMessageForNoAssignees = false;
      for (const call of global.chrome.runtime.sendMessage.mock.calls) {
        if (call[0].type === 'acquireLock' && call[0].username === 'No Assignees') {
          sendMessageForNoAssignees = true;
          break;
        }
      }
      expect(sendMessageForNoAssignees).toBe(false);
    });
  });

  describe("Idempotency and Marker Tests", () => {
    test("data-ghu-processed attribute should prevent re-processing", async () => {
      const img = document.createElement("img");
      img.setAttribute("data-testid", "github-avatar");
      img.setAttribute("alt", "projectUser1");
      img.setAttribute("data-ghu-processed", "true"); // Mark as already processed
      
      const h3 = document.createElement("h3");
      h3.textContent = "projectUser1"; // This would normally be processed
      h3.setAttribute("data-ghu-processed", "true"); // Mark as already processed
      
      const container = document.createElement("div");
      container.appendChild(img);
      container.appendChild(h3);
      document.body.appendChild(container);

      const fetchSpy = global.fetch;
      const sendMessageSpy = global.chrome.runtime.sendMessage;

      require("../content.js");
      await flushPromises();

      // Content should remain unchanged because it was marked as processed
      expect(img.getAttribute("alt")).toBe("projectUser1");
      expect(h3.textContent).toBe("projectUser1");

      // Verify fetch was not called for this user because it was skipped
      let calledForProjectUser1 = false;
      for (const call of fetchSpy.mock.calls) {
        if (call[0].includes("/projectUser1")) {
          calledForProjectUser1 = true;
          break;
        }
      }
      expect(calledForProjectUser1).toBe(false);

      // Verify sendMessage (for lock) was not called for this user
      let sendMessageForProjectUser1 = false;
      for (const call of sendMessageSpy.mock.calls) {
        if (call[0].type === 'acquireLock' && call[0].username === 'projectUser1') {
          sendMessageForProjectUser1 = true;
          break;
        }
      }
      expect(sendMessageForProjectUser1).toBe(false);
    });
  });
  
});
