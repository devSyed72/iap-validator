using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Purchasing;
using Unity.Services.Core;
using Unity.Services.Core.Environments;
using SolarEngine;
using Firebase.Analytics;
using GameLyft;

// Enum for product types
public enum ProductTypeEnum
{
    Consumable,
    NonConsumable,
    Subscription
}

// Class to hold product information
[System.Serializable]
public class IAPProduct
{
    public string productName; // For display purposes
    public string androidProductId;
    public string iosProductId;
    public decimal defaultPrice; // Default price if not retrieved from store
    public ProductTypeEnum productType;
    public string description; // Optional description

    // Get the correct product ID based on platform
    public string GetProductId()
    {
#if UNITY_IOS
            return iosProductId;
#else
        return androidProductId;
#endif
    }
}

// Main IAP Manager with Cloud Run server validation
public class IAPManager : MonoBehaviour, IStoreListener
{
    // Singleton instance
    private static IAPManager instance;
    public static IAPManager Instance
    {
        get
        {
            if (instance == null)
            {
                instance = FindObjectOfType<IAPManager>();
                if (instance == null)
                {
                    GameObject go = new GameObject("IAPManager");
                    instance = go.AddComponent<IAPManager>();
                    DontDestroyOnLoad(go);
                }
            }
            return instance;
        }
    }

    [Header("IAP Configuration")]
    public List<IAPProduct> iapProducts = new List<IAPProduct>();

    [Header("Validation Settings")]
    [SerializeField] private bool enableServerValidation = true;
    [SerializeField] private float validationTimeout = 15f;
    [SerializeField] private bool allowPurchaseOnValidationFailure = false; // Security setting

    // Store references
    private IStoreController storeController;
    private IExtensionProvider storeExtensionProvider;
    private IAppleExtensions appleExtensions;
    private IGooglePlayStoreExtensions googleExtensions;

    // Events for subscription state changes
    public event Action<string> OnSubscriptionPurchased;
    public event Action<string> OnSubscriptionExpired;
    public event Action<string> OnSubscriptionCancelled;
    public event Action<string> OnSubscriptionRenewed;
    public event Action<PurchaseEventArgs> OnPurchaseCompleted;
    public event Action<string> OnPurchaseFailedEvent;
    public event Action<string, InitializationFailureReason> OnInitializeFailedEvent;

    // Public property to check initialization status
    public bool IsInitialized => storeController != null && storeExtensionProvider != null;

    // Public getter for store controller (for SubscriptionManager)
    public IStoreController StoreController => storeController;

    void Awake()
    {
        if (instance == null)
        {
            instance = this;
            DontDestroyOnLoad(gameObject);
        }
        else if (instance != this)
        {
            Destroy(gameObject);
            return;
        }
    }

    async void Start()
    {
        // Initialize Unity Services
        try
        {
            var options = new InitializationOptions();
            options.SetEnvironmentName("production");
            await UnityServices.InitializeAsync(options);
            Debug.Log("Unity Services initialized successfully");

            // Initialize IAP
            InitializeIAP();
        }
        catch (Exception e)
        {
            Debug.LogError($"Unity Services initialization failed: {e}");
        }
    }

    void InitializeIAP()
    {
        if (IsInitialized) return;

        var builder = ConfigurationBuilder.Instance(StandardPurchasingModule.Instance());

        foreach (var product in iapProducts)
        {
            ProductType unityProductType = product.productType switch
            {
                ProductTypeEnum.Consumable => ProductType.Consumable,
                ProductTypeEnum.NonConsumable => ProductType.NonConsumable,
                ProductTypeEnum.Subscription => ProductType.Subscription,
                _ => ProductType.Consumable
            };

            builder.AddProduct(product.GetProductId(), unityProductType);
        }

        UnityPurchasing.Initialize(this, builder);
    }

    private void TrackBuyClickEvent(string productName)
    {
        string eventName = productName switch
        {
            "noads" => "remove_ads_click",
            "cash100" => "bank_cash_100_click",
            "cash500" => "bank_cash_500_click",
            "cash1000" => "bank_cash_1000_click",
            "cash2500" => "bank_cash_2500_click",
            "cash7500" => "bank_cash_7500_click",
            "cash10000" => "bank_cash_10000_click",
            "energy100" => "bank_energy_100_click",
            "energy500" => "bank_energy_500_click",
            "energy1000" => "bank_energy_1000_click",
            "energy2500" => "bank_energy_2500_click",
            "energy5000" => "bank_energy_5000_click",
            "energy10000" => "bank_energy_10000_click",
            "specialoffer" => "special_offer_click",
            _ => null
        };
        if (!string.IsNullOrEmpty(eventName))
            GameLyftAnalytics.Instance.TrackEvent(eventName);
    }

    // Public purchase methods
    public void BuyProduct(string productName)
    {
        TrackBuyClickEvent(productName);
        if (!IsInitialized)
        {
            Debug.LogError("IAP not initialized - cannot purchase");
            OnPurchaseFailedEvent?.Invoke(productName);
            return;
        }

        // Find the product in our configuration
        IAPProduct productConfig = iapProducts.Find(p => p.productName == productName);
        if (productConfig == null)
        {
            Debug.LogError($"Product {productName} not found in IAP configuration");
            OnPurchaseFailedEvent?.Invoke(productName);
            return;
        }

        string productId = productConfig.GetProductId();
        Product storeProduct = storeController.products.WithID(productId);

        if (storeProduct == null)
        {
            Debug.LogError($"Product {productName} (ID: {productId}) not found in store");
            OnPurchaseFailedEvent?.Invoke(productId);
            return;
        }

        if (!storeProduct.availableToPurchase)
        {
            Debug.LogError($"Product {productName} is not currently available for purchase");
            OnPurchaseFailedEvent?.Invoke(productId);
            return;
        }

        Debug.Log($"Initiating purchase for {productName} (ID: {productId})");
        storeController.InitiatePurchase(storeProduct);
    }

    public void RestorePurchases()
    {
        if (!IsInitialized) return;

        if (Application.platform == RuntimePlatform.IPhonePlayer ||
            Application.platform == RuntimePlatform.OSXPlayer)
        {
            Debug.Log("Starting purchase restoration...");

            appleExtensions?.RestoreTransactions((result, error) =>
            {
                Debug.Log($"Restore transactions result: {result}");
                if (!string.IsNullOrEmpty(error))
                {
                    Debug.LogError($"Restore transactions error: {error}");
                }
            });
        }
        else
        {
            Debug.Log("Restore purchases not supported on this platform");
        }
    }

    // Subscription management methods
    public bool IsSubscribed(string productId)
    {
        if (!IsInitialized) return false;

        Product product = storeController.products.WithID(productId);
        if (product == null) return false;

        // Check subscription status
        if (product.hasReceipt)
        {
            var subscriptionManager = new UnityEngine.Purchasing.SubscriptionManager(product, null);
            var info = subscriptionManager.getSubscriptionInfo();
            return info.isSubscribed() == Result.True;
        }

        return false;
    }

    public DateTime? GetSubscriptionExpirationDate(string productId)
    {
        if (!IsInitialized) return null;

        Product product = storeController.products.WithID(productId);
        if (product == null || !product.hasReceipt) return null;

        var subscriptionManager = new UnityEngine.Purchasing.SubscriptionManager(product, null);
        var info = subscriptionManager.getSubscriptionInfo();

        if (info.isSubscribed() == Result.True)
        {
            return info.getExpireDate();
        }

        return null;
    }

    // IStoreListener implementation
    public void OnInitialized(IStoreController controller, IExtensionProvider extensions)
    {
        Debug.Log("IAP initialized successfully");
        storeController = controller;
        storeExtensionProvider = extensions;

        appleExtensions = extensions.GetExtension<IAppleExtensions>();
        googleExtensions = extensions.GetExtension<IGooglePlayStoreExtensions>();

        // Check existing subscriptions
        CheckSubscriptionStatus();
    }

    public void OnInitializeFailed(InitializationFailureReason error)
    {
        Debug.LogError($"IAP initialization failed: {error}");
        OnInitializeFailedEvent?.Invoke("IAP", error);
    }

    public void OnInitializeFailed(InitializationFailureReason error, string message)
    {
        Debug.LogError($"IAP initialization failed: {error}. Message: {message}");
        OnInitializeFailedEvent?.Invoke(message, error);
    }

    // Helper method to get product name from ID
    private string GetProductNameFromId(string productId)
    {
        IAPProduct product = iapProducts.Find(p => p.GetProductId() == productId);
        return product != null ? product.productName : productId;
    }

    // UPDATED: Proper server validation with pending purchase
    public PurchaseProcessingResult ProcessPurchase(PurchaseEventArgs args)
    {
        Debug.Log($"Processing purchase: {args.purchasedProduct.definition.id}");

        // Basic validation first
        if (string.IsNullOrEmpty(args.purchasedProduct.receipt))
        {
            Debug.LogError("Receipt is empty");
            OnPurchaseFailedEvent?.Invoke(args.purchasedProduct.definition.id);
            return PurchaseProcessingResult.Complete;
        }

        if (enableServerValidation)
        {
            // Start async validation and return Pending
            StartCoroutine(ValidateAndProcessPurchase(args));
            return PurchaseProcessingResult.Pending;
        }
        else
        {
            // Process immediately without server validation (not recommended for production)
            Debug.LogWarning("Server validation is disabled - processing purchase immediately");
            ProcessValidatedPurchase(args);
            return PurchaseProcessingResult.Complete;
        }
    }

    // NEW: Coroutine for proper validation flow
    private IEnumerator ValidateAndProcessPurchase(PurchaseEventArgs args)
    {
        bool validationComplete = false;
        bool isValid = false;
        IAPReceiptValidator.ValidationResult validationResult = null;

        Debug.Log($"Starting server validation for: {args.purchasedProduct.definition.id}");

        // Start validation
        IAPReceiptValidator.Instance.ValidatePurchase(args.purchasedProduct, (valid, result) =>
        {
            isValid = valid;
            validationResult = result;
            validationComplete = true;
        });

        // Wait for validation to complete (with timeout)
        float elapsed = 0f;

        while (!validationComplete && elapsed < validationTimeout)
        {
            yield return new WaitForSeconds(0.1f);
            elapsed += 0.1f;
        }

        // Handle validation result
        if (validationComplete)
        {
            if (isValid)
            {
                Debug.Log($"Purchase validated successfully: {args.purchasedProduct.definition.id} (Processing time: {validationResult?.processingTime}ms)");
                ProcessValidatedPurchase(args);
            }
            else
            {
                Debug.LogError($"Purchase validation failed: {validationResult?.error}");

                if (allowPurchaseOnValidationFailure)
                {
                    Debug.LogWarning("Processing purchase despite validation failure (fallback enabled)");
                    ProcessValidatedPurchase(args);
                }
                else
                {
                    Debug.LogError("Rejecting purchase due to validation failure");
                    OnPurchaseFailedEvent?.Invoke(args.purchasedProduct.definition.id);
                }
            }
        }
        else
        {
            Debug.LogError($"Purchase validation timed out after {validationTimeout} seconds");

            if (allowPurchaseOnValidationFailure)
            {
                Debug.LogWarning("Processing purchase despite validation timeout (fallback enabled)");
                ProcessValidatedPurchase(args);
            }
            else
            {
                Debug.LogError("Rejecting purchase due to validation timeout");
                OnPurchaseFailedEvent?.Invoke(args.purchasedProduct.definition.id);
            }
        }

        // Confirm purchase with Unity (important!)
        if (storeController != null)
        {
            storeController.ConfirmPendingPurchase(args.purchasedProduct);
        }
    }

    // NEW: Process purchase after successful validation
    private void ProcessValidatedPurchase(PurchaseEventArgs args)
    {
        // Grant rewards based on product
        GrantPurchaseRewards(args.purchasedProduct.definition.id);

        var product = args.purchasedProduct;
        double revenue = (double)product.metadata.localizedPrice;
        string currency = product.metadata.isoCurrencyCode;

        // Analytics tracking
        ProductsAttributes productsAttributes = new ProductsAttributes();
        productsAttributes.product_id = args.purchasedProduct.definition.id;
        productsAttributes.currency_type = currency;
        productsAttributes.paystatus = PayStatus.Success;
        productsAttributes.pay_amount = revenue;
        SolarEngine.Analytics.trackPurchase(productsAttributes);

        try
        {
            // Create Firebase parameters
            var parameters = new[] {
                new Parameter("In-App_ID", args.purchasedProduct.definition.id),
                new Parameter(FirebaseAnalytics.ParameterCurrency, currency),
                new Parameter(FirebaseAnalytics.ParameterValue, (float)revenue),
                new Parameter(FirebaseAnalytics.ParameterSuccess, 1),
                new Parameter("product_name", GetProductNameFromId(args.purchasedProduct.definition.id)),
                new Parameter("validation_method", enableServerValidation ? "server" : "local")
            };

            // Log the purchase event
            FirebaseAnalytics.LogEvent(FirebaseAnalytics.EventPurchase, parameters);
            FirebaseAnalytics.LogEvent("Alytix_purchase", parameters);
            Debug.Log("Firebase purchase event logged successfully");
        }
        catch (Exception e)
        {
            Debug.LogError($"Failed to log Firebase purchase event: {e.Message}");
        }

        // Fire purchase completed event
        OnPurchaseCompleted?.Invoke(args);

        // Check if it's a subscription
        if (args.purchasedProduct.definition.type == ProductType.Subscription)
        {
            OnSubscriptionPurchased?.Invoke(args.purchasedProduct.definition.id);

            // Let SubscriptionManager handle the subscription
            if (SubscriptionManager.Instance != null)
            {
                SubscriptionManager.Instance.ProcessSubscriptionPurchase(args);
            }
        }
    }

    public void OnPurchaseFailed(Product product, PurchaseFailureReason failureReason)
    {
        Debug.LogError($"Purchase failed: {product.definition.storeSpecificId}, Reason: {failureReason}");
        OnPurchaseFailedEvent?.Invoke(product.definition.id);

        double revenue = (double)product.metadata.localizedPrice;
        string currency = product.metadata.isoCurrencyCode;

        ProductsAttributes productsAttributes = new ProductsAttributes();
        productsAttributes.product_id = product.definition.id;
        productsAttributes.currency_type = currency;
        productsAttributes.fail_reason = failureReason.ToString();
        productsAttributes.paystatus = PayStatus.Fail;
        productsAttributes.pay_amount = revenue;
        SolarEngine.Analytics.trackPurchase(productsAttributes);

        // Track failed purchase in Firebase Analytics
        try
        {
            var parameters = new[] {
                new Parameter("In-App_ID", product.definition.id),
                new Parameter(FirebaseAnalytics.ParameterCurrency, currency),
                new Parameter(FirebaseAnalytics.ParameterValue, (float)revenue),
                new Parameter(FirebaseAnalytics.ParameterSuccess, 0),
                new Parameter("fail_reason", failureReason.ToString()),
                new Parameter("product_name", GetProductNameFromId(product.definition.id))
            };

            FirebaseAnalytics.LogEvent("purchase_failed", parameters);
        }
        catch (Exception e)
        {
            Debug.LogError($"Failed to log Firebase purchase failure event: {e.Message}");
        }
    }

    void GrantPurchaseRewards(string productId)
    {
        IAPProduct product = iapProducts.Find(p => p.GetProductId() == productId);
        if (product == null) return;

        Debug.Log($"Granting rewards for: {product.productName}");

        switch (product.productName)
        {
            case "noads":
                GetRemoveAds();
                break;
            case "cash100":
                GameManager.instance.AddCash(100);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_cash_100", 100, GameManager.EconomyCurrency.cash);
                break;
            case "cash500":
                GameManager.instance.AddCash(500);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_cash_500", 500, GameManager.EconomyCurrency.cash);
                break;
            case "cash1000":
                GameManager.instance.AddCash(1000);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_cash_1000", 1000, GameManager.EconomyCurrency.cash);
                break;
            case "cash2500":
                GameManager.instance.AddCash(2500);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_cash_2500", 2500, GameManager.EconomyCurrency.cash);
                break;
            case "cash7500":
                GameManager.instance.AddCash(7500);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_cash_7500", 7500, GameManager.EconomyCurrency.cash);
                break;
            case "cash10000":
                GameManager.instance.AddCash(10000);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_cash_10000", 10000, GameManager.EconomyCurrency.cash);
                break;
            case "energy100":
                GameManager.instance.AddEnergy(100, true);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_energy_100", 100, GameManager.EconomyCurrency.energy);
                break;
            case "energy500":
                GameManager.instance.AddEnergy(500, true);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_energy_500", 500, GameManager.EconomyCurrency.energy);
                break;
            case "energy1000":
                GameManager.instance.AddEnergy(1000, true);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_energy_1000", 1000, GameManager.EconomyCurrency.energy);
                break;
            case "energy2500":
                GameManager.instance.AddEnergy(2500, true);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_energy_2500", 2500, GameManager.EconomyCurrency.energy);
                break;
            case "energy5000":
                GameManager.instance.AddEnergy(5000, true);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_energy_5000", 5000, GameManager.EconomyCurrency.energy);
                break;
            case "energy10000":
                GameManager.instance.AddEnergy(10000, true);
                GameManager.instance?.TrackEconomy(GameManager.EconomyAction.source, "bank_energy_10000", 10000, GameManager.EconomyCurrency.energy);
                break;
            case "specialoffer":
                GetRemoveAds();
                UiHandler.instance?.CloseAllGetWelcomeOfferInapp();
                GameManager.instance?.AddEnergy(50, true);
                GameManager.instance?.AddCash(2000);
                break;
            case "limitedtimeoffer":
                GetRemoveAds();
                UiHandler.instance?.CloseAllGetLimitedInapp();
                GameManager.instance?.AddCash(3000);
                GameManager.instance?.DirectLicenseOwn();
                break;
            case "premiumpass":
                GetRemoveAds();
                GameManager.instance?.AddEnergy(50);
                DailyRewardSystem.instance?.ActivateSubscriptionRewards();
                UiHandler.instance?.CloseAllVipOfferInapp();
                TimeOfDaySystem.instance?.SubscriptionBonus.SetActive(false);
                break;
            case "giftpack":
                GetRemoveAds();
                UiHandler.instance?.CloseAllGiftOfferInapp();
                GameManager.instance?.AddEnergy(20);
                GameManager.instance?.AddCash(1000);
                break;
            case "specialnoads":
                GetRemoveAds();
                GameManager.instance?.AddEnergy(50);
                GameManager.instance?.AddCash(100);
                UiHandler.instance?.CloseSppecialRemoveAdsPaneel();
                break;
        }
    }

    public void GetRemoveAds()
    {
        PlayerPrefs.SetString(GlobalValues.RemoveAds, "true");
        UiHandler.instance?.ShopPanel.inappPanel.AfterRemoveAdsPanel.SetActive(true);
        UiHandler.instance?.ShopPanel.inappPanel.removeAdsPanel.SetActive(false);
        UiHandler.instance?.CloseRemoveAdsPaneel();
        AdsHandler.Instance?.HideBanner1Ad();
        AdsHandler.Instance?.HideMrecBannerAd();
    }

    void CheckSubscriptionStatus()
    {
        if (!IsInitialized) return;

        // Check all products and find subscriptions
        foreach (var product in iapProducts)
        {
            if (product.productType != ProductTypeEnum.Subscription)
                continue;

            string productId = product.GetProductId();
            Product storeProduct = storeController.products.WithID(productId);

            if (storeProduct != null && storeProduct.hasReceipt)
            {
                var subscriptionManager = new UnityEngine.Purchasing.SubscriptionManager(storeProduct, null);
                var info = subscriptionManager.getSubscriptionInfo();

                if (info.isSubscribed() == Result.True)
                {
                    Debug.Log($"Active subscription found: {product.productName} ({productId})");

                    // Grant subscription benefits
                    GrantPurchaseRewards(productId);

                    // Update expiration dates in PlayerData if needed
                    DateTime? expireDate = info.getExpireDate();
                    if (expireDate.HasValue)
                    {
                        if (product.productName.Contains("VIP"))
                        {
                            //PlayerData.Instance.SetVIPExpiration(expireDate.Value);
                        }
                        else if (product.productName.Contains("Premium"))
                        {
                            ///PlayerData.Instance.SetPremiumExpiration(expireDate.Value);
                        }
                    }
                }
            }
        }
    }

    string GetUserId()
    {
        // Return your user ID implementation
        return SystemInfo.deviceUniqueIdentifier;
    }
}