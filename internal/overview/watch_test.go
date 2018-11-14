package overview

import (
	"testing"
	"time"

	"github.com/heptio/developer-dash/internal/cluster/fake"
	"github.com/heptio/developer-dash/internal/log"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

func newScheme() *runtime.Scheme {
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "DeploymentList"}, &unstructured.UnstructuredList{})
	return scheme
}

func TestWatch(t *testing.T) {
	scheme := newScheme()

	objects := []runtime.Object{
		newUnstructured("apps/v1", "Deployment", "default", "deploy3"),
	}

	clusterClient, err := fake.NewClient(scheme, objects)
	require.NoError(t, err)

	discoveryClient := clusterClient.FakeDiscovery
	discoveryClient.Resources = []*metav1.APIResourceList{
		{
			GroupVersion: "apps/v1",
			APIResources: []metav1.APIResource{
				{
					Name:         "deployments",
					SingularName: "deployment",
					Group:        "apps",
					Version:      "v1",
					Kind:         "Deployment",
					Namespaced:   true,
					Verbs:        metav1.Verbs{"list", "watch"},
					Categories:   []string{"all"},
				},
			},
		},
	}

	dynamicClient := clusterClient.FakeDynamic

	notifyCh := make(chan CacheNotification)
	notifyDone := make(chan struct{})

	cache := NewMemoryCache(CacheNotificationOpt(notifyCh, notifyDone))

	watch := NewWatch("default", clusterClient, cache, log.TestLogger(t))

	stopFn, err := watch.Start()
	require.NoError(t, err)

	defer func() {
		close(notifyDone) // Unblock any pending cache notifications so that stopFn can complete
		stopFn()
	}()

	// wait for cache to store initial items
	select {
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for initial object to notify")
	case <-notifyCh:
	}

	// verify predefined objects made it to the cache via watch->notify
	found, err := cache.Retrieve(CacheKey{Namespace: "default"})
	require.NoError(t, err)

	require.Len(t, found, 1)

	// define new object
	obj := &unstructured.Unstructured{}
	obj.SetAPIVersion("apps/v1")
	obj.SetKind("Deployment")
	obj.SetName("deploy2")
	obj.SetNamespace("default")

	res := schema.GroupVersionResource{
		Group:    "apps",
		Version:  "v1",
		Resource: "deployments",
	}

	resClient := dynamicClient.Resource(res).Namespace("default")

	// create object
	_, err = resClient.Create(obj)
	require.NoError(t, err)

	// wait for cache to store an item before proceeding.
	select {
	case <-time.After(10 * time.Second):
		t.Fatal("timed out wating for create object to notify")
	case <-notifyCh:
	}

	found, err = cache.Retrieve(CacheKey{Namespace: "default"})
	require.NoError(t, err)

	// 2 == initial + the new object
	require.Len(t, found, 2)

	annotations := map[string]string{"update": "update"}
	obj.SetAnnotations(annotations)

	// update object
	_, err = resClient.Update(obj)
	require.NoError(t, err)

	// wait for cache to store an item before proceeding.
	select {
	case <-time.After(2 * time.Second):
		t.Fatal("timed out wating for update object to notify")
	case <-notifyCh:
	}

	found, err = cache.Retrieve(CacheKey{Namespace: "default"})
	require.NoError(t, err)

	require.Len(t, found, 2)

	// Find the object we updated
	var match bool
	for _, u := range found {
		if u.GetName() == obj.GetName() && u.GroupVersionKind() == obj.GroupVersionKind() {
			match = true
			require.Equal(t, annotations, u.GetAnnotations())
		}
	}
	require.True(t, match, "unable to find object from fetched results")
}

func TestWatch_Stop(t *testing.T) {
	scheme := newScheme()

	objects := []runtime.Object{
		newUnstructured("apps/v1", "Deployment", "default", "deploy3"),
	}

	clusterClient, err := fake.NewClient(scheme, objects)
	require.NoError(t, err)

	discoveryClient := clusterClient.FakeDiscovery
	discoveryClient.Resources = []*metav1.APIResourceList{
		{
			GroupVersion: "apps/v1",
			APIResources: []metav1.APIResource{
				{
					Name:         "deployments",
					SingularName: "deployment",
					Group:        "apps",
					Version:      "v1",
					Kind:         "Deployment",
					Namespaced:   true,
					Verbs:        metav1.Verbs{"list", "watch"},
					Categories:   []string{"all"},
				},
			},
		},
		{
			GroupVersion: "v1",
			APIResources: []metav1.APIResource{
				{
					Name:         "services",
					SingularName: "service",
					Group:        "",
					Version:      "v1",
					Kind:         "Service",
					Namespaced:   true,
					Verbs:        metav1.Verbs{"list", "watch"},
					Categories:   []string{"all"},
				},
			},
		},
	}

	notifyCh := make(chan CacheNotification)
	notifyDone := make(chan struct{})

	cache := NewMemoryCache(CacheNotificationOpt(notifyCh, notifyDone))

	watch := NewWatch("default", clusterClient, cache, log.TestLogger(t))

	stopFn, err := watch.Start()
	require.NoError(t, err)

	// Stop the watchers (blocking) and make sure it completes
	stopDone := make(chan interface{})
	go func() {
		close(notifyDone) // Unblock any pending cache notifications so that stopFn can complete
		stopFn()
		close(stopDone)
	}()

	select {
	case <-time.After(2 * time.Second):
		t.Fatal("timed out wating for watchers to stop")
	case <-stopDone:
		// Success
	}
}

func newUnstructured(apiVersion, kind, namespace, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": apiVersion,
			"kind":       kind,
			"metadata": map[string]interface{}{
				"namespace": namespace,
				"name":      name,
			},
		},
	}
}