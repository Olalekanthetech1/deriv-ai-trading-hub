import os
import sys

def run_smoke_tests():
    print("--- ML NATIVE DEPENDENCY SELF-TEST ---")
    
    # Check for misconfigurations
    is_prod = os.getenv("RENDER") == "true" or os.getenv("NODE_ENV") == "production"
    print(f"Production Mode Enforced: {is_prod}")
    
    # 1. Test numpy
    try:
        import numpy as np
        print(f"[Numpy] NATIVE_AVAILABLE: {np.__version__}")
        a = np.array([1, 2, 3])
        assert a.sum() == 6
    except Exception as e:
        if is_prod:
            print(f"[Numpy] CONFIGURATION_ERROR: Missing native dependency in production - {e}")
        else:
            print(f"[Numpy] FALLBACK_ONLY: Native unavailable - {e}")
        
    # 2. Test sklearn
    try:
        import sklearn
        from sklearn.ensemble import IsolationForest
        print(f"[Scikit-Learn] NATIVE_AVAILABLE: {sklearn.__version__}")
        import numpy as np
        X = np.random.rand(100, 2)
        iso = IsolationForest(n_estimators=5, random_state=42)
        iso.fit(X)
        preds = iso.predict(X)
        assert len(preds) == 100
    except Exception as e:
        if is_prod:
            print(f"[Scikit-Learn] CONFIGURATION_ERROR: Missing native dependency in production - {e}")
        else:
            print(f"[Scikit-Learn] FALLBACK_ONLY: Native unavailable - {e}")

    # 3. Test xgboost
    try:
        import xgboost as xgb
        print(f"[XGBoost] NATIVE_AVAILABLE: {xgb.__version__}")
        import numpy as np
        X = np.random.rand(100, 2)
        y = np.random.randint(0, 2, size=100)
        dtrain = xgb.DMatrix(X, label=y)
        param = {'max_depth': 2, 'eta': 1, 'objective': 'binary:logistic'}
        bst = xgb.train(param, dtrain, num_boost_round=2)
        preds = bst.predict(dtrain)
        assert len(preds) == 100
    except Exception as e:
        if is_prod:
            print(f"[XGBoost] CONFIGURATION_ERROR: Missing native dependency in production - {e}")
        else:
            print(f"[XGBoost] NATIVE_UNAVAILABLE: {e}")

    # 4. Test lightgbm
    try:
        import lightgbm as lgb
        print(f"[LightGBM] NATIVE_AVAILABLE: {lgb.__version__}")
        import numpy as np
        X = np.random.rand(100, 2)
        y = np.random.randint(0, 2, size=100)
        train_data = lgb.Dataset(X, label=y)
        param = {'objective': 'binary'}
        bst = lgb.train(param, train_data, num_boost_round=2)
        preds = bst.predict(X)
        assert len(preds) == 100
    except Exception as e:
        if is_prod:
            print(f"[LightGBM] CONFIGURATION_ERROR: Missing native dependency in production - {e}")
        else:
            print(f"[LightGBM] NATIVE_UNAVAILABLE: {e}")

    # 5. Test catboost
    try:
        import catboost as cb
        print(f"[CatBoost] NATIVE_AVAILABLE: {cb.__version__}")
        import numpy as np
        X = np.random.rand(100, 2)
        y = np.random.randint(0, 2, size=100)
        model = cb.CatBoostClassifier(iterations=2, learning_rate=1, depth=2, logging_level='Silent')
        model.fit(X, y)
        preds = model.predict(X)
        assert len(preds) == 100
    except Exception as e:
        if is_prod:
            print(f"[CatBoost] CONFIGURATION_ERROR: Missing native dependency in production - {e}")
        else:
            print(f"[CatBoost] NATIVE_UNAVAILABLE: {e}")

    # 6. Test hmmlearn
    try:
        import hmmlearn
        from hmmlearn.hmm import GaussianHMM
        print(f"[HMMLearn] NATIVE_AVAILABLE: {hmmlearn.__version__}")
        import numpy as np
        X = np.random.rand(100, 2)
        model = GaussianHMM(n_components=2, covariance_type="diag", n_iter=2)
        model.fit(X)
        preds = model.predict(X)
        assert len(preds) == 100
    except Exception as e:
        if is_prod:
            print(f"[HMMLearn] CONFIGURATION_ERROR: Missing native dependency in production - {e}")
        else:
            print(f"[HMMLearn] FALLBACK_ONLY: Native unavailable - {e}")

    # 7. Test PyTorch
    try:
        import torch
        import torch.nn as nn
        print(f"[PyTorch] NATIVE_AVAILABLE: {torch.__version__}")
        
        # Test minimal CPU execution
        tensor = torch.tensor([[1.0, 2.0], [3.0, 4.0]])
        linear = nn.Linear(2, 1)
        out = linear(tensor)
        assert out.shape == (2, 1)
        print("[PyTorch] CPU execution works.")
    except Exception as e:
        if is_prod:
            print(f"[PyTorch] CONFIGURATION_ERROR: Missing native dependency in production - {e}")
        else:
            print(f"[PyTorch] FALLBACK_ONLY: Native unavailable - {e}")

if __name__ == '__main__':
    run_smoke_tests()
