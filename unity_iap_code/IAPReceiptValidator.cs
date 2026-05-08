using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.Purchasing;

// Receipt validation helper for secure IAP verification
public class IAPReceiptValidator : MonoBehaviour
{
    // UPDATED: Your actual Cloud Run URL with correct endpoint
    private const string CLOUD_RUN_VALIDATION_ENDPOINT = "https://iap-validator-700115340332.us-central1.run.app/api/v1/validate-purchase";

    // REQUIRED: Your API key and Game ID for authentication
    private const string API_KEY = "asrg_26231117484a66236e577252b04c48fe711d2ea1c1bc660093a57d025f2c6bfb";
    private const string GAME_ID = "arcade-simulator-retro-games";

    [Header("Validation Settings")]
    [SerializeField] private float validationTimeout = 15f;
    [SerializeField] private bool enableFallbackOnError = false; // Set to false for security

    private static IAPReceiptValidator instance;
    public static IAPReceiptValidator Instance
    {
        get
        {
            if(instance == null)
            {
                instance = FindObjectOfType<IAPReceiptValidator>();
                if(instance == null)
                {
                    GameObject go = new GameObject("IAPReceiptValidator");
                    instance = go.AddComponent<IAPReceiptValidator>();
                    DontDestroyOnLoad(go);
                }
            }
            return instance;
        }
    }

    public void ValidatePurchase(Product product, Action<bool, ValidationResult> callback)
    {
        if(string.IsNullOrEmpty(product.receipt))
        {
            Debug.LogError("Receipt is empty");
            callback?.Invoke(false, new ValidationResult { isValid = false, error = "Empty receipt" });
            return;
        }

        StartCoroutine(ValidateOnCloudRun(product, callback));
    }

    IEnumerator ValidateOnCloudRun(Product product, Action<bool, ValidationResult> callback)
    {
        // Prepare request data for your new server structure
        CloudRunValidationRequest requestData = new CloudRunValidationRequest
        {
            receipt = product.receipt,
            productId = product.definition.id,
            userId = GetUserId(),
            platform = "android"
        };

        // Convert to JSON
        string jsonData = JsonUtility.ToJson(requestData);
        Debug.Log($"Sending validation request for product: {product.definition.id} to game: {GAME_ID}");

        // Create request
        using(UnityWebRequest request = new UnityWebRequest(CLOUD_RUN_VALIDATION_ENDPOINT, "POST"))
        {
            byte[] bodyRaw = System.Text.Encoding.UTF8.GetBytes(jsonData);
            request.uploadHandler = new UploadHandlerRaw(bodyRaw);
            request.downloadHandler = new DownloadHandlerBuffer();

            // Set required headers for your authentication middleware
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("X-API-Key", API_KEY);
            request.SetRequestHeader("X-Game-ID", GAME_ID);

            // Set timeout
            request.timeout = Mathf.RoundToInt(validationTimeout);

            yield return request.SendWebRequest();

            if(request.result == UnityWebRequest.Result.Success)
            {
                try
                {
                    CloudRunValidationResponse response = JsonUtility.FromJson<CloudRunValidationResponse>(request.downloadHandler.text);

                    if(response.isValid)
                    {
                        ValidationResult result = new ValidationResult
                        {
                            isValid = true,
                            productId = product.definition.id,
                            transactionId = response.transactionId,
                            purchaseDate = DateTime.Now,
                            processingTime = response.processingTime
                        };

                        Debug.Log($"Purchase validated successfully: {product.definition.id} (Processing time: {response.processingTime}ms)");

                        // Track validated purchase in Firebase
                        TrackValidatedPurchase(result);

                        callback?.Invoke(true, result);
                    }
                    else
                    {
                        Debug.LogError($"Purchase validation failed: {response.error}");
                        callback?.Invoke(false, new ValidationResult
                        {
                            isValid = false,
                            error = response.error,
                            processingTime = response.processingTime
                        });
                    }
                }
                catch(Exception ex)
                {
                    Debug.LogError($"Failed to parse validation response: {ex.Message}");
                    Debug.LogError($"Response text: {request.downloadHandler.text}");
                    callback?.Invoke(false, new ValidationResult
                    {
                        isValid = false,
                        error = "Parse error"
                    });
                }
            }
            else
            {
                string errorMsg = $"Server validation failed: {request.error}";
                Debug.LogError(errorMsg);

                // SECURITY: Don't allow purchase on server error unless explicitly enabled
                bool allowPurchase = enableFallbackOnError;

                if(allowPurchase)
                {
                    Debug.LogWarning("Allowing purchase despite validation failure (fallback enabled)");
                }

                callback?.Invoke(allowPurchase, new ValidationResult
                {
                    isValid = allowPurchase,
                    error = errorMsg,
                    productId = product.definition.id
                });
            }
        }
    }

    void TrackValidatedPurchase(ValidationResult result)
    {
        // Track in Firebase Analytics
        try
        {
            var parameters = new[] {
                new Firebase.Analytics.Parameter("product_id", result.productId),
                new Firebase.Analytics.Parameter("transaction_id", result.transactionId),
                new Firebase.Analytics.Parameter("processing_time", result.processingTime),
                new Firebase.Analytics.Parameter("validation_source", "cloud_run")
            };

            Firebase.Analytics.FirebaseAnalytics.LogEvent("purchase_validated", parameters);
            Debug.Log("Firebase validation event logged successfully");
        }
        catch(Exception e)
        {
            Debug.LogError($"Failed to log Firebase validation event: {e.Message}");
        }
    }

    string GetUserId()
    {
        // Return your user ID - could be from your backend, device ID, or generated UUID
        return PlayerPrefs.GetString("UserId", SystemInfo.deviceUniqueIdentifier);
    }

    // Updated data structures for new server API
    [Serializable]
    public class ValidationResult
    {
        public bool isValid;
        public string error;
        public string productId;
        public string transactionId;
        public DateTime purchaseDate;
        public int processingTime;
    }

    [Serializable]
    class CloudRunValidationRequest
    {
        public string receipt;
        public string productId;
        public string userId;
        public string platform;
    }

    [Serializable]
    class CloudRunValidationResponse
    {
        public bool isValid;
        public string gameId;
        public string transactionId;
        public string purchaseTime;
        public int purchaseState;
        public int consumptionState;
        public string error;
        public int processingTime;
    }
}

// Extension to integrate with IAPManager
public static class IAPManagerValidationExtension
{
    public static void ProcessPurchaseWithValidation(PurchaseEventArgs args, Action<bool> onComplete)
    {
        IAPReceiptValidator.Instance.ValidatePurchase(args.purchasedProduct, (isValid, result) =>
        {
            if(isValid)
            {
                Debug.Log($"Purchase validated: {result.productId} (Time: {result.processingTime}ms)");
                onComplete?.Invoke(true);
            }
            else
            {
                Debug.LogError($"Purchase validation failed: {result.error}");
                // SECURITY: Reject invalid purchases
                onComplete?.Invoke(false);
            }
        });
    }
}